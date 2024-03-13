import exec from 'k6/execution';
import { API } from './API';
import { config } from './Config';
import { Logger } from './Logger';
import { Metrics } from './Metrics';
import { IResponse, IResponseErrorData, Utils } from './Utils';
import ErrCode from './tallyup-server/errors/ErrCode';
import { IExposedUser, IExposedUserPlaySession, IExposedUserProgressTrackers } from './tallyup-server/dtos/types/ExposedUserTypes';
import { CurrencyType, IUserProfile, UserPlaySessionStatus, UserQueueStatus, UserSpecialEventStatus } from './tallyup-server/models/types/UserTypes';
import { IExposedGame, IExposedGameData } from './tallyup-server/dtos/types/ExposedGameTypes';
import { ClientEventType, GameStatus, GameType, IGameButton } from './tallyup-server/models/types/GameTypes';
import { Action, ActionResult, Dispatcher } from './Action';
import { LeaderboardType } from './tallyup-server/models/types/LeaderboardTypes';
import { FeedType, IGameFeedItem } from './tallyup-server/models/types/FeedItemTypes';
import { ProgressTrackerState, UserPlaySessionType } from './tallyup-server/models/types/UserTypes';
import { IExposedSpecialEvent, IExposedSpecialEventUserSequence } from './tallyup-server/dtos/types/ExposedSpecialEventTypes';
import { IExposedPublicUsersBrief } from './tallyup-server/dtos/types/ExposedPublicUserTypes';
import { IItem, ItemType } from './tallyup-server/models/types/ItemTypes';
import { SpecialEventType } from './tallyup-server/models/types/SpecialEventTypes';

const logger = new Logger('Client');

const delay = Utils.delay;
const delayRange = Utils.delayRange;
const randomInRange = Utils.randomInRange;

type IXUser = IExposedUser & {
	liveSession?: IExposedUserPlaySession;
} | undefined;

type IXGame = IExposedGame<IExposedGameData<any, any, any, any>>;	// eslint-disable-line @typescript-eslint/no-explicit-any

interface ISpecialEventScreenData {
	specialEvents: IExposedSpecialEventUserSequence;
}

interface ILevelDesc {
	level: number;
	amount: number;
	available: boolean;
	unlocksAtRank: number;
}

export class Client {
	private api: API;
	private metrics: Metrics;
	private phone: string;
	private startTime: number;
	private testDuration: number;
	private startRampDownElapsed: number;
	private rampDownDuration: number;
	private vusMax: number;
	private user: IXUser;	// Last user fetched
	private playAsync: boolean;	// Will make async challenges and play async games
	private opponentUsername: string|undefined;	// Opponent faced in last game played
	private opponentIsBot: boolean|undefined;
	private progressTrackers: IExposedUserProgressTrackers|undefined;
	private currentScreen: string|undefined;
	private checkResponseError = ActionResult.OK;
	private levels: ILevelDesc[];
	private maxLevel: number;
	private testSuffix = `_${__ENV.TEST_ID}`;

	constructor(api: API, metrics: Metrics, phone: string, startTime: number, testDuration: number, startRampDownElapsed: number, rampDownDuration: number, vusMax: number) {
		this.api = api;
		this.metrics = metrics;
		this.user = undefined;
		this.opponentUsername = undefined;
		this.opponentIsBot = undefined;
		this.playAsync = config.playAsync === true;
		this.phone = phone;
		this.startTime = startTime;
		this.testDuration = testDuration;
		this.startRampDownElapsed = startRampDownElapsed;
		this.rampDownDuration = rampDownDuration;
		this.vusMax = vusMax;
		this.progressTrackers = undefined;
		this.levels = [];
		this.maxLevel = 0;
	}

	public session(): void {
		logger.debug('startTime=' + this.startTime + ', startRampDownElapsed=' + this.startRampDownElapsed + ', rampDownDuration=' + this.rampDownDuration + ', vusMax=' + this.vusMax);

		if (shouldExitIteration(this.doLoadingScreen()))
			return;
		if (shouldExitIteration(this.doHomeScreen()))
			return;

		const actions = new Dispatcher('session', [
			new Action(5, 'exit', () => {
				// Stop playing for a while
				logger.info('Exiting session...');
				delayRange(60, 120);
				return ActionResult.ExitApp;
			}),
			new Action(10, 'activityScreen', () => this.doActivityScreen()),
			new Action(10, 'goalsScreen', () => this.doGoalsScreen()),
			new Action(10, 'homeScreen', () => this.doHomeScreen()),
			this.playAsync ? [
				new Action(10, 'eventsScreen', () => this.doEventsScreen()),
				new Action(10, 'socialScreen', () => this.doSocialScreen())
			] : null
		]);
		actions.noRepeats = true;

//		ActionSet.forceActions(['homeScreen.playRandom', 'pvpScreen?.startChallenge']);
		let result = this.doHomeScreen();

		while (!this.rampDown()) {
			// TODO: Prioritize responding to alert 'badges'
			if (this.playAsync && result === ActionResult.GoToMatchups)
				result = actions.dispatchAction('socialScreen');
			else
				result = actions.dispatch();
			if (shouldExitIteration(result))
				return;
		}
	}

	//==========================================================================
	// Simulated client screens
	//==========================================================================

	private doLoadingScreen(): ActionResult {
		let resp = this.sessionStart();
		if (resp.error) {
			logger.error('Error at start of session: ' + JSON.stringify(resp));
			if (resp.error.status === 400 && resp.__type === 'TooManyRequestsException') {
				this.metrics.cognitoThrottleCount.add(1);   // This will abort entire test if it exceeds metric threshold set in options by Main.ts
				backoff(600);
				return ActionResult.FatalError;
			} else if (resp.error.status == null || resp.error.status as number >= 500) {
				// Retryable server or client networking error
				backoff(60);
				return ActionResult.FatalError;
			}
			// Non-retryable client error - kill VU for rest of test
			logger.warn(`Non-retryable error Stopping VU: ${__VU}`);
			this.killVU(this.testDuration, this.startTime);
			return ActionResult.Done;
		}
		if (!this.user) {
			logger.error(`No user at start of session! Stopping VU: ${__VU}`);
			this.killVU(this.testDuration, this.startTime);
			return ActionResult.Done;
		}
		resp = this.getConfig('towerdata');
		if (!resp.error) {
			for (const stage of resp.data as ILevelDesc[][]) {
				for (const level of stage) {
					this.levels.push(level);
					if (level.available && level.level > this.maxLevel)
						this.maxLevel = level.level;
				}
			}
		}
		resp = this.getConfig('appData');
		if (!resp.error) {
			//this.megaSpinMinimumRank = (resp.data as Record<string, unknown>).megaSpinMinimumRank as number;
			//this.maxMatchmakingLevel = resp.data.maxMatchmakingLevel;
		}
		this.getUser();
		this.getConfig('charitydata');
		return ActionResult.OK;
	}

	private doHomeScreen(): ActionResult {
		if (this.currentScreen === 'home')
			return ActionResult.Skipped;
		this.currentScreen = 'home';
		this.metrics.homeScreenCount.add(1, { });
		const actions = new Dispatcher('homeScreen', [
			this.getMenuBarActions(),
			new Action(70, 'playRandom', () => this.doPlayRandomLiveLevel()),
			new Action(5, 'powerPlaySettings', () => this.doPowerPlaySettingsScreen())
		]);
		this.getProgressTrackers();
		let currentEventId: string;
		const updateFeaturedEvents = (): void => {
			const eventsResp = this.getHomeSpecialEvents();
			this.getActiveCount();
			if (!eventsResp.error && Array.isArray(eventsResp.data) && eventsResp.data.length &&
				(eventsResp.data[0].id !== currentEventId || eventsResp.data[0].type === SpecialEventType.Surge)) {
				this.getSpecialEvents();
				const leaderboardType = eventsResp.data[0].type === SpecialEventType.Surge ? LeaderboardType.SurgeScore : LeaderboardType.AdHocScore;
				this.getLeaderboard(leaderboardType, eventsResp.data[0].id);
			}
		};
		updateFeaturedEvents();
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			// Try to spin if no balance
			if (this.user && this.user.account < 1 && (this.hasBasicSpins() || this.hasMegaSpins())) {
				const resp = this.homeSpinner();
				if (resp.error) {
					if (resp.error.msg)
						logger.error(resp.error.msg);
					delay(300); 	// 5 min cooldown before retrying
					return ActionResult.ExitApp;
				}
			}
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result))
				return result;
			if (result !== ActionResult.Skipped) {
				updateFeaturedEvents();
			}
		}
		return ActionResult.Done;
	}

	private doPowerPlaySettingsScreen(): ActionResult {
		if (this.currentScreen === 'powerPlaySettings' || !this.user)
			return ActionResult.Skipped;
		this.currentScreen = 'powerPlaySettings';
		this.metrics.powerPlaySettingsScreenCount.add(1, { });
		if (this.user && !this.user.profile) {
			logger.error(`Profile undefined: user=${JSON.stringify(this.user, null, 4)}`);
		}
		let active = !!this.user?.profile?.useDefaultMatchmakingLevel;
		let min = this.user?.profile?.lowestMatchmakingLevel || 0;
		let max = Math.min(this.user?.profile?.defaultMatchmakingLevel || this.maxLevel, this.maxLevel);	// Convert 999999 to actual max
		const actions = new Dispatcher('powerPlaySettingsScreen', [
			new Action(25, 'back', () => ActionResult.LeaveScreen),
			// Bigger chance to turn on Power Play than off. Bigger chance to leave after turning off
			new Action(active ? 10 : 90, 'toggleActive', () => okOrBackOrError(this.postUpdateProfile({ useDefaultMatchmakingLevel: (active = !active) }), active ? 50 : 90)),
			new Action(25, 'setMinimum', () => okOrBackOrError(this.postUpdateProfile({ lowestMatchmakingLevel: (min = randomInRange(0, Math.max(0, Math.trunc(max / 2)))) }), 75), () => active),
			new Action(25, 'setMaximum', () => okOrBackOrError(this.postUpdateProfile({ defaultMatchmakingLevel: (max = randomInRange(Math.min(min * 2, max), this.maxLevel)) }), 75), () => active)
		]);
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result)) {
				this.getSpecialEvents();	// This seems to always be the first call when returning to the home screen
				// Returning LeaveScreen would change tabs on parent screen and we don't want that
				return result === ActionResult.LeaveScreen ? ActionResult.OK : result;
			}
		}
		return ActionResult.Done;
	}

	private doSettingsScreen(): ActionResult {
		if (this.currentScreen === 'settings' || !this.user)
			return ActionResult.Skipped;
		this.currentScreen = 'settings';
		this.metrics.settingsScreenCount.add(1, { });
		if (this.user && !this.user.profile) {
			logger.error(`Profile undefined: user=${JSON.stringify(this.user, null, 4)}`);
		}
		let excludeBots = !!this.user?.profile?.excludeBots;
		const actions = new Dispatcher('settingsScreen', [
			new Action(25, 'back', () => ActionResult.LeaveScreen),
			new Action(10, 'cashOut', () => okOrError(this.cashOut()), () => this.hasAccount(1000)),
			new Action(25, 'setInviter', () => okOrError(this.setInviter(exec.instance.vusActive))),
			new Action(25, 'recentGames', () => okOrError(this.getRecentGames())),
			new Action(excludeBots ? 80 : 5, 'toggleIncludeBots', () => okOrBackOrError(this.postUpdateProfile({ excludeBots: (excludeBots = !excludeBots) }), 75)),
			new Action(25, 'powerPlaySettings', () => this.doPowerPlaySettingsScreen())
		]);
		let result = ActionResult.OK;
		const doSingleAction = true;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (doSingleAction || shouldLeaveScreen(result)) {
				// Returning LeaveScreen would change tabs on parent screen and we don't want that
				return result === ActionResult.LeaveScreen ? ActionResult.OK : result;
			}
		}
		return ActionResult.Done;
	}

	private doWalletDetailsScreen(): ActionResult {
		if (this.currentScreen === 'wallet' || !this.user)
			return ActionResult.Skipped;
		this.currentScreen = 'wallet';
		const actions = new Dispatcher('walletDetailsScreen', [
			new Action(25, 'back', () => ActionResult.LeaveScreen),
			new Action(10, 'cashOut', () => okOrError(this.cashOut()), () => this.hasAccount(1000)),
			new Action(65, 'spin', () => okOrError(this.homeSpinner()))
		]);
		let result = ActionResult.OK;
		const doSingleAction = true;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (doSingleAction || shouldLeaveScreen(result)) {
				// Returning LeaveScreen would change tabs on parent screen and we don't want that
				return result === ActionResult.LeaveScreen ? ActionResult.OK : result;
			}
		}
		return ActionResult.Done;
	}

	private doActivityScreen(): ActionResult {
		if (this.currentScreen === 'activity')
			return ActionResult.Skipped;
		this.currentScreen = 'activity';
		this.metrics.activityScreenCount.add(1, { });
		const doLeaderboard = (type: LeaderboardType): ActionResult => okOrError(this.getLeaderboard(type));
		const actions = new Dispatcher('activityScreen', [
			this.getMenuBarActions(46),
			new Action(6, 'feed', () => this.doFeedTab(FeedType.Winnings)),
			new Action(6, 'winningsToday', () => doLeaderboard(LeaderboardType.WinningsToday)),
			new Action(6, 'winningsYesterday', () => doLeaderboard(LeaderboardType.WinningsYesterday)),
			new Action(6, 'winningsThisWeek', () => doLeaderboard(LeaderboardType.WinningsThisWeek)),
			new Action(6, 'winningsLastWeek', () => doLeaderboard(LeaderboardType.WinningsLastWeek)),
			new Action(6, 'highestBalance', () => doLeaderboard(LeaderboardType.HighestBalance)),
			new Action(6, 'currentBalance', () => doLeaderboard(LeaderboardType.CurrentBalance)),
			new Action(6, 'mostDonated', () => doLeaderboard(LeaderboardType.MostDonated)),
			new Action(6, 'surge', () => doLeaderboard(LeaderboardType.SurgeScore))
		]);
		let result = okOrError(this.getActivityFeed(FeedType.Winnings));
		if (shouldLeaveScreen(result))
			return result;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result))
				return result;
		}
		return ActionResult.Done;
	}

	private doGoalsScreen(): ActionResult {
		if (this.currentScreen === 'arcade')
			return ActionResult.Skipped;
		this.currentScreen = 'arcade';
		this.metrics.goalsScreenCount.add(1, { });
		const actions = new Dispatcher('goalsScreen', [
			this.getMenuBarActions(),
			new Action(35, 'claim', () => okOrError(this.claimGoalAwards())),
			new Action(35, 'practice', () => this.doPlayRandomArcadeLevel())
		]);
		this.getSpecialEvents();
		this.progressTrackers = this.getProgressTrackers().data as IExposedUserProgressTrackers;
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result))
				return result;
			this.progressTrackers = this.getProgressTrackers().data as IExposedUserProgressTrackers;
		}
		return ActionResult.Done;
	}

	private doEventsScreen(): ActionResult {
		if (!this.playAsync)
			return ActionResult.Skipped;
		if (this.currentScreen === 'events')
			return ActionResult.Skipped;
		this.currentScreen = 'events';
		this.metrics.eventsScreenCount.add(1, { });
		const data = {} as ISpecialEventScreenData;
		const update = (): IResponse => {
			let resp = this.getUser();
			if (isFatal(resp.error))
				return resp;
			resp = this.getSpecialEvents();
			if (isFatal(resp.error))
				return resp;
			if (!resp.error)
				data.specialEvents = resp.data as IExposedSpecialEventUserSequence;
			return resp;
		};
		const doIdle = (): ActionResult => {
			// Like a timer for periodic updates when idle
			delayRange(5, 45);
			return toActionResult(update());
		};
		const doSelectEventDetails = (): ActionResult => {
			let event: IExposedSpecialEvent|undefined = undefined;
			if (data.specialEvents?.current && data.specialEvents.current.length) {
				// Prioritized actions - maybe randomize using Action dispatch?
				event = data.specialEvents.current.find(e => e.userStatus === UserSpecialEventStatus.Won || e.userStatus === UserSpecialEventStatus.RunnerUp);
				if (!event)
					event = data.specialEvents.current.find(e => e.userStatus === UserSpecialEventStatus.Playing);
				if (!event)
					event = data.specialEvents.current.find(e => e.userStatus === UserSpecialEventStatus.Active);
				if (!event)
					event = data.specialEvents.current.find(e => e.userStatus === UserSpecialEventStatus.Eliminated);
				if (!event)
					event = data.specialEvents.current.find(e => e.userStatus === UserSpecialEventStatus.Uninvolved);
			}
			if (!event && data.specialEvents?.last && data.specialEvents.last.length)
				event = data.specialEvents.last[Math.floor(Math.random() * data.specialEvents.last.length)];
			if (!event && data.specialEvents?.next && data.specialEvents.next.length)
				event = data.specialEvents.next[Math.floor(Math.random() * data.specialEvents.next.length)];
			if (event)
				return this.doEventDetailScreen(data, event);
			else
				return ActionResult.Skipped;
		};
		const doSelectHiddenEventDetails = (): ActionResult => {
			const numHiddenJoined = data.specialEvents?.current?.filter(e => e.isHidden).length ?? 0;
			if (numHiddenJoined < config.maxHiddenTournaments) {
				const accessCode = config.events.find((configEvent: IExposedSpecialEvent) => configEvent.isHidden && !data.specialEvents?.current?.find(e => specialEventEqual(e, configEvent))).inviteCode + this.testSuffix;
				logger.info(`Trying hidden access code: ${accessCode}`);
				const resp = this.getInviteOnlySpecialEvent(accessCode);
				if (!resp.error) {
					return this.doEventDetailScreen(data, resp.data, accessCode);
				} else {
					logger.error(resp.error.msg as string);
				}
			}
			return ActionResult.Skipped;
		};
		const actions = new Dispatcher('eventsScreen', [
			this.getMenuBarActions(),
			new Action(20, 'idle', () => doIdle()),
			new Action(50, 'selectEventDetails', () => doSelectEventDetails()),
			new Action(10, 'selectHiddenEventDetails', () => doSelectHiddenEventDetails())
		]);
		update();
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result))
				return result;
			if (isFatal(update().error))
				return ActionResult.FatalError;
		}
		return ActionResult.Done;
	}

	private doEventDetailScreen(parentData: ISpecialEventScreenData, specialEvent: IExposedSpecialEvent, hiddenAccessCode?: string): ActionResult {
		if (this.currentScreen === 'eventDetails')
			return ActionResult.Skipped;
		this.currentScreen = 'eventDetails';
		this.metrics.eventDetailsScreenCount.add(1, { });
		let id = specialEvent.id;
		let selectedTab: 'leaderboard'|'feed' = 'leaderboard';
		const updateAll = (): IResponse => {
			let resp = this.getUser();
			if (isFatal(resp.error))
				return resp;
			resp = this.getSpecialEvents();
			if (isFatal(resp.error))
				return resp;
			if (!resp.error) {
				// Update our parent eventScreen's list (this is effectively like updating a pass-by-reference variable)
				parentData.specialEvents = resp.data as IExposedSpecialEventUserSequence;
				// Update our target event
				if (!hiddenAccessCode) {
					let updatedEvent = parentData.specialEvents.last?.find(e => e.id === specialEvent.id);
					if (!updatedEvent)
						updatedEvent = parentData.specialEvents.current?.find(e => e.id === specialEvent.id);
					if (!updatedEvent)
						updatedEvent = parentData.specialEvents.next?.find(e => e.id === specialEvent.id);
					if (!updatedEvent)
						return { error: { msg: `Cannot find specialEvent ${specialEvent.id} in eventDetailsScreen after update!`}};
					specialEvent = updatedEvent;
				}
			}
			if (selectedTab === 'leaderboard') {
				resp = this.getLeaderboard(LeaderboardType.AdHocScore, specialEvent.id);
			} else {
				resp = this.getActivityFeed(FeedType.AdHoc, specialEvent.id);
			}
			return resp;
		};
		const updateSingle = (): IResponse => {
			let resp: IResponse;
			if (hiddenAccessCode && (!specialEvent.userStatus || specialEvent.userStatus === UserSpecialEventStatus.Uninvolved)) {
				resp = this.getInviteOnlySpecialEvent(hiddenAccessCode);
			} else {
				resp = this.getSpecialEvent(id);
			}
			if (!resp.error) {
				specialEvent = resp.data as IExposedSpecialEvent;
				id = specialEvent.id;
				let parentDataIndex: number|undefined;
				if (parentData.specialEvents.last && (parentDataIndex = parentData.specialEvents.last.map((e: IExposedSpecialEvent) => e.id).indexOf(id)) >= 0) {
					parentData.specialEvents.last[parentDataIndex] = specialEvent;
				} else if (parentData.specialEvents.current && (parentDataIndex = parentData.specialEvents.current.map((e: IExposedSpecialEvent) => e.id).indexOf(id)) >= 0) {
					parentData.specialEvents.current[parentDataIndex] = specialEvent;
				} else if (parentData.specialEvents.next && (parentDataIndex = parentData.specialEvents.next.map((e: IExposedSpecialEvent) => e.id).indexOf(id)) >= 0) {
					parentData.specialEvents.next[parentDataIndex] = specialEvent;
				}
			}
			return resp;
		};
		const doLeaderboardTab = (): ActionResult => {
			if (selectedTab === 'leaderboard')
				return ActionResult.Skipped;
			const resp = this.getLeaderboard(LeaderboardType.AdHocScore, specialEvent.id);
			if (isFatal(resp.error))
				return ActionResult.FatalError;
			selectedTab = 'leaderboard';
			return ActionResult.OK;
		};
		const doFeedTab = (): ActionResult => {
			if (selectedTab === 'feed')
				return ActionResult.Skipped;
			selectedTab = 'feed';
			return this.doFeedTab(FeedType.AdHoc, specialEvent.id);
		};
		const doMain = (): ActionResult => {
			// Action - grayed out if waiting (for round or move) - join, take turn, claim, see results (load, ack, matchup against, back to events)
			const session = getAsyncSessionForSpecialEvent(this.user, specialEvent.id);
			// Prioritized actions - maybe randomize using Action dispatch?
			switch (specialEvent.userStatus) {
			case UserSpecialEventStatus.Active:
			case UserSpecialEventStatus.Playing:	// Note, this is not actually used except in returned leaderboard data, but included here for completeness
				if (session && session.requiresAction) {
					// We're playing a game and we need to do something
					if (session.status === UserPlaySessionStatus.Playing) {
						logger.debug(`Event ${specialEvent.name}: Make move...`);
						return this.doAsyncMakeMove(session);
					} else if (session.status !== UserPlaySessionStatus.Completed) {
						// See result
						logger.debug(`Event ${specialEvent.name}: See result...`);
						return this.doAsyncSeeResult(session);
					}
					logger.error(new Error(`session.requiresAction in doEventDetailScreen but status is ${session.status}`).stack as string);
				}
				logger.debug(`Event ${specialEvent.name}: Skip...`);
				return ActionResult.Skipped;	// Waiting for round to begin or opponent to make a move - can't do anything
			case UserSpecialEventStatus.Won:
			case UserSpecialEventStatus.RunnerUp:// Claim reward
				logger.debug(`Event ${specialEvent.name}: Claim...`);
				return this.doClaimSpecialEventPrize(specialEvent);
			case UserSpecialEventStatus.Uninvolved:
				logger.debug(`Event ${specialEvent.name}: Join...`);
				return this.doJoinSpecialEvent(specialEvent, hiddenAccessCode);
			case UserSpecialEventStatus.Eliminated:
				logger.debug(`Event ${specialEvent.name}: Rejoin...`);
				return this.doRejoinSpecialEvent(specialEvent);	// If rejoin cost and window not closed yet, then rejoin
			default:
				logger.debug(`Event ${specialEvent.name}: Skip... (userStatus=${specialEvent.userStatus})`);
				return ActionResult.Skipped;	// Nothing to do
			}
		};
		const actions = new Dispatcher('eventDetailsScreen', [
			new Action(25, 'back', () => ActionResult.LeaveScreen),
			new Action(5, 'leaderboard', () => doLeaderboardTab()),
			new Action(5, 'feed', () => doFeedTab()),
			new Action(10, 'idle', () => { delayRange(5, 45); return toActionResult(updateAll()); }),	// Like a timer for periodic updates when idle
			new Action(55, 'eventAction', () => doMain())
		]);
		updateAll();
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result)) {
				// Returning LeaveScrean would change tabs on parent screen and we don't want that
				return result === ActionResult.LeaveScreen ? ActionResult.OK : result;
			}
			if (isFatal(updateSingle().error))
				return ActionResult.FatalError;
		}
		return ActionResult.Done;
	}

	private doSocialScreen(): ActionResult {
		if (this.currentScreen === 'social')
			return ActionResult.Skipped;
		this.currentScreen = 'social';
		if (!this.playAsync)
			return ActionResult.Skipped;
		this.metrics.socialScreenCount.add(1, { });
		const challengees = {} as IExposedPublicUsersBrief;
		const update = (): IResponse => {
			let resp = this.getUser();
			if (isFatal(resp.error))
				return resp;
			resp = this.findChallengees();
			if (isFatal(resp.error))
				return resp;
			if (!resp.error)
				challengees.users = (resp.data as IExposedPublicUsersBrief).users;
			return resp;
		};
		const doSearchForUser = (): ActionResult => {
			// Generate a random username up to 1 less than the current user's number
			const n = Utils.getNumberFromPhone(this.phone);
			if (n < 2)
				return ActionResult.Skipped;
			const opponentUsername = Utils.getUsernameFromNumber(Math.floor(Math.max(1, (n - 1) * Math.random())));
			return this.doPvPScreen(opponentUsername);
		};
		const doMain = (): ActionResult => {
			// Prioritized actions - maybe randomize using Action dispatch?
			let session = getAsyncSessionWithStatus(this.user, UserPlaySessionStatus.Playing, true);
			if (session) {
				logger.debug('Make move...');
				return this.doAsyncMakeMove(session);	// TAKE TURN
			}
			session = getAsyncSessionWithStatus(this.user, UserPlaySessionStatus.Completed);
			if (session) {
				logger.debug('See result...');
				return this.doAsyncSeeResult(session);	// SEE RESULT
			}
			session = getAsyncSessionWithStatus(this.user, UserPlaySessionStatus.ChallengeReceived);
			if (session) {
				logger.debug('Go to PvP...');
				return this.doPvPScreen(session.opponentUsername);	// VIEW
			}
			session = getAsyncSessionWithStatus(this.user, UserPlaySessionStatus.ChallengeRejected);
			if (session) {
				logger.debug('Acknowledge declined...');
				return this.doAsyncAcknowledgeMatch(session);	// OK (ack declined)
			}
			// Their move - nothing to do
			const choice = Math.round(100 * Math.random());
			if (choice <= 50 && challengees.users.length) {
				// Pick a challengee we don't already have a match with
				const opponentUsername = challengees.users[Math.floor(Math.random() * challengees.users.length)].username;
				if (!getAsyncSessionAgainst(this.user, opponentUsername)) {
					logger.debug('Go to PvP...');
					return this.doPvPScreen(opponentUsername);
				}
			}
			logger.debug('Skip...');
			return ActionResult.OK;
		};
		const actions = new Dispatcher('socialScreen', [
			this.getMenuBarActions(),
			new Action(10, 'searchForUser', () => doSearchForUser()),
			new Action(10, 'idle', () => { delayRange(5, 45); return toActionResult(update()); }),	// Like a timer for periodic updates when idle
			new Action(50, 'matchupAction', () => doMain()),
		]);
		update();
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result))
				return result;
			if (isFatal(update().error))
				return ActionResult.FatalError;
		}
		return ActionResult.Done;
	}

	private doPvPScreen(opponentUsername: string|undefined): ActionResult {
		if (this.currentScreen === 'pvp')
			return ActionResult.Skipped;
		this.currentScreen = 'pvp';
		if (!this.playAsync)
			return ActionResult.Skipped;
		this.metrics.pvpScreenCount.add(1, { });
		let mainAction: Action|Action[]|null = null;
		const session = getAsyncSessionAgainst(this.user, opponentUsername);
		if (session) {
			switch (session.status) {
			case UserPlaySessionStatus.ChallengeReceived:
				mainAction = [
					new Action(37.5, 'accept', () => this.doAsyncAcceptChallenge(session)),
					new Action(37.5, 'reject', () => this.doAsyncDeclineChallenge(session))
				];
				break;
			case UserPlaySessionStatus.Playing:
				if (session.requiresAction)
					mainAction = new Action(75, 'move', () => this.doAsyncMakeMove(session));
				break;
			case UserPlaySessionStatus.ChallengeRejected:
				mainAction = new Action(75, 'ackRejected', () => this.doAsyncAcknowledgeMatch(session));
				break;
			case UserPlaySessionStatus.Completed:
				mainAction = new Action(75, 'startChallenge', () => this.doAsyncSeeResult(session));
				break;
			default:
				// No action possible - button would be grayed out
			}
		} else {
			mainAction = new Action(75, 'startChallenge', () => this.doAsyncIssueChallenge(opponentUsername));
		}
		const actions = new Dispatcher('pvpScreen', [
			new Action(25, 'back', () => ActionResult.OK),
			mainAction
		]);
		let resp = this.findUser(opponentUsername);
		if (isFatal(resp.error))
			return ActionResult.FatalError;
		if (resp.error || !(resp.data as unknown[])?.length)
			return ActionResult.Error;
		resp = this.getStats(opponentUsername);
		if (isFatal(resp.error))
			return ActionResult.FatalError;
		return actions.dispatch();
	}

	//==========================================================================
	// Screen action helpers
	//==========================================================================

	private doPlayRandomArcadeLevel(): ActionResult {
		let resp = this.playLevel(UserPlaySessionType.Arcade, 0);	// No need to select a game type we have unlocked - just let server choose
		if (resp.cancelled)
			return ActionResult.OK;
		if (!resp.error) {
			resp = this.unloadLiveGame();
			const actions = new Dispatcher('arcadeGameOver', [
				!this.opponentIsBot ? new Action(10, 'matchupAgainst', () => this.doPvPScreen(this.opponentUsername)) : null,
				new Action(90, 'backToArcade', () => ActionResult.OK)
			]);
			return actions.dispatch();
		}
		return ActionResult.FatalError;
	}

	private doPlayRandomLiveLevel(): ActionResult {
		let resp = this.playRandomLevel();
		if (resp.cancelled)
			return ActionResult.OK;
		if (!resp.error) {
			resp = this.unloadLiveGame();
			resp = this.getLeaderboard(LeaderboardType.SurgeScore);
			const actions = new Dispatcher('homeGameOver', [
				!this.opponentIsBot ? new Action(10, 'matchupAgainst', () => this.doPvPScreen(this.opponentUsername)) : null,
				new Action(90, 'backToTower', () => ActionResult.OK)
			]);
			return actions.dispatch();
		}
		return ActionResult.FatalError;
	}

	private doAsyncIssueChallenge(opponentUsername: string|undefined): ActionResult {
		if (this.user?.sessions?.find(s => s.opponentUsername === opponentUsername && s.status !== UserPlaySessionStatus.Completed))
			return ActionResult.Skipped;	// Already have an active session with this opponent
		const level = Math.min(Math.max(this.user?.account ? Math.round(maxLevel(this.user.account) * Math.random()) : 0, 0), this.maxLevel);
		logger.debug(`Issuing challenge to ${opponentUsername} at level ${level}...`);
		let resp = this.postRequestMatch(UserPlaySessionType.Challenge, level, opponentUsername);
		if (!this.checkResponse(resp, 'request_match')) {
			if (resp.error?.msg?.startsWith('User rank is too low to request this level')) {
				logger.error(`Username: ${this.user?.username}, rank: ${this.user?.rank}, xp: ${this.user?.xp}, level: ${level}`);
			}
			return this.checkResponseError;
		}
		const respData = resp.data as { user: IXUser, sessionId: string };
		this.setUser(respData.user);
		const sessionId = respData.sessionId;
		const session = this.user?.sessions?.find(s => s.id === sessionId);
		if (!session) {
			logger.error(`Error! doAsyncIssueChallenge(${opponentUsername}): session ${sessionId} not found after request_match!`);
			return ActionResult.Error;
		}
		logger.debug(`Starting challenge with ${opponentUsername}, session ${sessionId}, game ${session.game}`);
		resp = this.loadAsyncGame(session.game);
		if (!this.checkResponse(resp, 'loadAsyncGame'))
			return this.checkResponseError;
		const game = resp.data as IXGame;
		const gameType = game.type;
		this.opponentUsername = opponentUsername;
		resp = this.beginRoundTimer(game);
		if (!this.checkResponse(resp, 'beginRoundTimer'))
			return this.checkResponseError;
		// 10% chance to return without making 1st move?
		// Play 1st move
		resp = this.makeMove(game);
		if (!this.checkResponse(resp, 'makeMove'))
			return this.checkResponseError;
		this.unloadAsyncGame();
		this.metrics.asyncGameStarts.add(1, { game: gameType, level: session.requestedLevel .toString() });
		return toActionResult(resp);
	}

	private doAsyncAcceptChallenge(session: IExposedUserPlaySession): ActionResult {
		if ((this.user?.account || 0) < session.matchedLevelValue)
			return ActionResult.Skipped;
		const resp = this.postAcceptMatch(session.id);
		if (!this.checkResponse(resp, 'accept_match'))
			return this.checkResponseError;
		this.setUser(resp.data);
		this.metrics.asyncGameAccepts.add(1, { game: session.gameType, level: session.requestedLevel .toString() });
		return ActionResult.OK;
	}

	private doAsyncDeclineChallenge(session: IExposedUserPlaySession): ActionResult {
		const resp = this.postDeclineMatch(session.id);
		if (!this.checkResponse(resp, 'decline_match'))
			return this.checkResponseError;
		this.setUser(resp.data);
		this.metrics.asyncGameDeclines.add(1, { game: session.gameType, level: session.requestedLevel .toString() });
		return ActionResult.OK;
	}

	private doAsyncMakeMove(session: IExposedUserPlaySession): ActionResult {
		let resp = this.loadAsyncGame(session.game);
		if (!this.checkResponse(resp, 'loadAsyncGame'))
			return this.checkResponseError;
		const game = resp.data as IXGame;
		this.opponentUsername = session.opponentUsername;
		// 10% chance to return without making move?
		if (game?.status === GameStatus.gameComplete) {
			resp = this.postGamesEvent(game.id, ClientEventType.ackResult);
			if (!this.checkResponse(resp, 'postGamesEvent', true))
				return this.checkResponseError;
			resp = this.postAcknowledgeMatch(session.id);
			if (!this.checkResponse(resp, 'acknowledge_match', true))
				return this.checkResponseError;
			if (!resp.error) {
				this.setUser(resp.data);
				this.metrics.asyncGameCompletes.add(1, { game: (resp.data as IXGame).type, level: session.requestedLevel.toString() });
			}
		} else {
			resp = this.beginRoundTimer(resp.data as IXGame);
			if (!this.checkResponse(resp, 'beginRoundTimer', true))
				return this.checkResponseError;
			resp = this.makeMove(resp.data as IXGame);
			if (!this.checkResponse(resp, 'makeMove', true))
				return this.checkResponseError;
			if (!resp.error) {
				this.metrics.asyncGameMoves.add(1, { game: (resp.data as IXGame).type, level: session.requestedLevel.toString() });
			}
		}
		resp = this.unloadAsyncGame();
		if (game?.status === GameStatus.gameComplete) {
			const actions = new Dispatcher('arcadeGameOver', [
				!this.opponentIsBot ? new Action(10, 'matchupAgainst', () => this.doPvPScreen(session.opponentUsername)) : null,
				new Action(90, 'backToEvents/Matchups', () => ActionResult.OK)
			]);
			return actions.dispatch();
		}
		return ActionResult.OK;
	}

	private doAsyncSeeResult(session: IExposedUserPlaySession): ActionResult {
		let resp = this.loadAsyncGame(session.game);
		if (!this.checkResponse(resp, 'loadAsyncGame'))
			return this.checkResponseError;
		const game = resp.data as IXGame;
		this.opponentUsername = session.opponentUsername;
		resp = this.postGamesEvent(game.id, ClientEventType.ackResult);
		if (!resp.error) {
			this.metrics.asyncGameCompletes.add(1, { game: (resp.data as IXGame).type, level: session.requestedLevel.toString() });
		}
		resp = this.postAcknowledgeMatch(session.id);
		if (!this.checkResponse(resp, 'acknowledge_match', true))
			return this.checkResponseError;
		if (!resp.error)
			this.setUser(resp.data);
		resp = this.unloadAsyncGame();
		if (game?.status === GameStatus.gameComplete) {
			const actions = new Dispatcher('arcadeGameOver', [
				!this.opponentIsBot ? new Action(10, 'matchupAgainst', () => this.doPvPScreen(session.opponentUsername)) : null,
				new Action(90, 'backToEvents/Matchups', () => ActionResult.OK)
			]);
			return actions.dispatch();
		}
		return ActionResult.FatalError;
	}

	private doAsyncAcknowledgeMatch(session: IExposedUserPlaySession): ActionResult {
		const resp = this.postAcknowledgeMatch(session.id);
		if (!this.checkResponse(resp, 'acknowledge_match'))
			return this.checkResponseError;
		this.setUser(resp.data);
		return ActionResult.OK;
	}

	private doClaimSpecialEventPrize(specialEvent: IExposedSpecialEvent): ActionResult {
		const resp = this.postSpecialEventsClaim(specialEvent.id, `${this.user?.username}@loadtest.tallyup.com`);
		if (!this.checkResponse(resp, 'special_events/claim', true))
			return this.checkResponseError;
		if (!resp.error) {
			this.setUser(resp.data);
			this.metrics.eventPrizesClaimedCount.add(1);
		}
		return toActionResult(resp);
	}

	private doJoinSpecialEvent(specialEvent: IExposedSpecialEvent, hiddenAccessCode?: string): ActionResult {
		if  (Date.now() >= Date.parse(specialEvent.close.toString()))
			return ActionResult.Skipped;
		if (specialEvent.joinCost) {
			if (specialEvent.joinCurrency === CurrencyType.Primary) {
				if (!this.hasAccount(specialEvent.joinCost))
					return ActionResult.Skipped;
			} else {
				if (!this.hasSecondaryAccount(specialEvent.joinCost))
					return ActionResult.Skipped;
			}
		}
		let inviteCode = undefined as unknown as string;
		if (specialEvent.hasInviteCode) {
			if (hiddenAccessCode) {
				inviteCode = hiddenAccessCode;
			} else {
				// Find the access code from the events config
				const configEvent = config.events.find((e: IExposedSpecialEvent) => specialEventEqual(e, specialEvent));
				inviteCode = configEvent.inviteCode + this.testSuffix;
			}
		}
		const resp = this.postSpecialEventsJoin(specialEvent.id, inviteCode);
		if (!this.checkResponse(resp, 'special_events/join'))
			return this.checkResponseError;
		this.setUser(resp.data);
		return toActionResult(resp);
	}

	private doRejoinSpecialEvent(specialEvent: IExposedSpecialEvent): ActionResult {
		if (!specialEvent.userNextRejoinCost || Date.now() >= Date.parse(specialEvent.close.toString()))
			return ActionResult.Skipped;	// Either non-rejoinable or entry window has closed
		if (specialEvent.userRejoinCurrency === CurrencyType.Primary) {
			if (!this.hasAccount(specialEvent.userNextRejoinCost))
				return ActionResult.Skipped;
		} else {
			if (!this.hasSecondaryAccount(specialEvent.userNextRejoinCost))
				return ActionResult.Skipped;
		}
		const resp = this.postSpecialEventsRejoin(specialEvent.id);
		if (!this.checkResponse(resp, 'special_events/rejoin'))
			return this.checkResponseError;
		this.setUser(resp.data);
		return toActionResult(resp);
	}

	private doFeedTab(type: FeedType, specialEventId?: string): ActionResult {
		const resp = this.getActivityFeed(type, specialEventId);
		if (!this.checkResponse(resp, 'feeds/activity', true))
			return this.checkResponseError;
		if (resp.error)
			return ActionResult.Error;
		const feedItems = resp.data as IGameFeedItem[];
		const actions = new Dispatcher('feedTab', [
			new Action(25, 'back', () => ActionResult.LeaveScreen),
			new Action(50, 'idle', () => { delayRange(5, 20); return ActionResult.OK; }),
			new Action(25, 'watchReplay', () => {
				// Find an item with a watchable game
				const item = feedItems.length && feedItems[Math.floor(Math.random() * feedItems.length)];
				if (!item)
					return ActionResult.Skipped;
				const resp = this.getGamesWatch(item.gameId);
				if (isFatal(resp.error))
					return ActionResult.FatalError;
				if (resp.error)
					return ActionResult.Error;
				this.metrics.replaysWatchedCount.add(1);
				delayRange(10, 300);	// Enough time to watch a game (or quit before end)
				return ActionResult.OK;
			})
		]);
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result)) {
				// Returning LeaveScrean would change tabs on parent screen and we don't want that
				return result === ActionResult.LeaveScreen ? ActionResult.OK : result;
			}
		}
		return ActionResult.Done;
	}

	//==========================================================================
	// Helper methods
	//==========================================================================

	private sessionStart(): IResponse {
		const startupResp = this.postStartup();
		if (startupResp.error)
			return startupResp;
		const authResp = this.api.auth(this.phone);
		if (authResp.error)
			return authResp;
		this.user = undefined;
		let sessionResp = this.postSessionStart();
		if (sessionResp.error && sessionResp.error.code === ErrCode.UserNotFound) {
			const registerResp = this.postRegister();
			if (registerResp.error)
				return registerResp;
			sessionResp = registerResp;
		}
		if ((sessionResp.data as IExposedUser)?.inviteData?.status !== UserQueueStatus.Playing) {
			const activateResp = this.postActivate(Utils.getUsernameFromPhone(this.phone));
			if (activateResp.error)
				return activateResp;
			sessionResp = activateResp;
		}
		this.setUser(sessionResp.data);
		if (!this.user)
			return sessionResp;

		// To simplify the client logic and bookkeeping, ensure that users have
		// a high enough rank to skip the tutorial training goals, can play any
		// level, have all games unlocked, have adequate balances to play for a
		// while, and have enough powerups to continue playing if their balance
		// reaches zero
		// NOTE: We know 'this.user' is non-null at this point but Typescript still complains, so use '!.'
		if (this.user!.rank < 20) {
			if ((sessionResp = this.postSetXp(1734)).error)
				return sessionResp;
		}
		if (!this.user!.available_games?.CrystalCaveGame?.isUnlocked) {
			if ((sessionResp = this.postUnlockGame('CrystalCaveGame')).error)
				return sessionResp;
		}
		if (!this.user!.available_games?.ShootingGalleryGame?.isUnlocked) {
			if ((sessionResp = this.postUnlockGame('ShootingGalleryGame')).error)
				return sessionResp;
		}
		if (!this.user!.available_games?.AsteroidGame?.isUnlocked) {
			if ((sessionResp = this.postUnlockGame('AsteroidGame')).error)
				return sessionResp;
		}
		if (this.user!.account < 500) {
			if ((sessionResp = this.postSetBalance(500)).error)
				return sessionResp;
		}
		if (this.user!.secondaryAccount < 100) {
			if ((sessionResp = this.postSetSecondaryBalance(100)).error)
				return sessionResp;
		}
		// NOTE: item quantity is a two-decimal-place fixed-point value (* 100)
		if (!this.findItem(ItemType.MegaSpin)) {
			if ((sessionResp = this.postAddItem(ItemType.MegaSpin, 500)).error)
				return sessionResp;
		}
		if (!this.findItem(ItemType.BasicSpin)) {
			if ((sessionResp = this.postAddItem(ItemType.BasicSpin, 1000)).error)
				return sessionResp;
		}
		this.setUser(sessionResp.data);
		return sessionResp;
	}

	private setInviter(vusMax: number): IResponse {
		if (this.user && !this.user.inviteData?.invited) {
			logger.info('Set inviter...');
			let attempts = 10;
			while (attempts-- > 0) {
				const n = 1 + Math.floor((vusMax - 1) * Math.random());
				const inviter = Utils.getUsernameFromNumber(n);
				if (inviter !== this.user.username) {
					const resp = this.postSetInviter(inviter);
					if (!resp.error)
						this.setUser(resp.data);
					return resp;
				}
			}
		}
		return {
			error: {
				msg: 'Cannot find another user for setInviter'
			}
		};
	}

	private cashOut(): IResponse {
		logger.info('Cash out...');
		if (!this.user) {
			logger.error('No user for cashout!');
			return { error: { msg: 'No user!' }};
		}
		let resp = this.postCashoutStart();
		if (!this.checkResponse(resp, 'users/cashout_start'))
			return resp;
		if ((resp?.data as Record<string, unknown>)?.isAllowed) {
			const availableBalance = this.user.account;
			const charityPercent = 10 + Math.round(90 * Math.random());
			const charityAmount = Math.floor(availableBalance * (charityPercent / 100));
			const playerAmount = availableBalance - charityAmount;
			delayRange(1, 30);
			resp = this.postCashoutFinish(charityPercent, charityAmount, playerAmount, `fake_${this.user?.phone.slice(2)}@tallyup.com`);
			if (!this.checkResponse(resp, 'users/cashout_finish'))
				return resp;
			this.setUser(resp.data);
		}
		return resp;
	}

	private homeSpinner(): IResponse {
		const choice = Math.round(100 * Math.random());
		// TODO: Update when ads are watched
		let resp = this.postAdsStart();
		if (resp.error)
			return resp;
		logger.debug('Watching ad...');
		delayRange(5, 35);
		resp = this.postAdsFinish();
		if (resp.error)
			return resp;
		if (this.user) {
			if (this.hasMegaSpins() && (choice > 50 || !this.hasBasicSpins())) {
				logger.debug('Home screen start using MegaSpin...');
				resp = this.postUseItem(ItemType.MegaSpin);
				if (!resp.error) {
					this.metrics.megaSpinCount.add(1);
				} else {
					if (resp.error?.msg?.startsWith('User rank is too low to do this action')) {
						logger.error(`Username: ${this.user?.username}, rank: ${this.user?.rank}, xp: ${this.user?.xp}, item: ${ItemType.MegaSpin}`);
					}
				}
			} else if (this.hasBasicSpins()) {
				logger.debug('Home screen start using basic spin...');
				resp = this.postUseItem(ItemType.BasicSpin);
				if (!resp.error) {
					this.metrics.basicSpinCount.add(1);
				} else {
					if (resp.error?.msg?.startsWith('User rank is too low to do this action')) {
						logger.error(`Username: ${this.user?.username}, rank: ${this.user?.rank}, xp: ${this.user?.xp}, item: ${ItemType.BasicSpin}`);
					}
				}
			}
			if (!resp.error)
				this.setUser(resp.data);
		}
		return resp;
	}

	private requestLevel(sessionType: UserPlaySessionType, level: number): boolean {
		let resp = this.postRequestMatch(sessionType, level, undefined);
		if (!this.checkResponse(resp, 'games/request_match')) {
			if (resp.error?.msg?.startsWith('User rank is too low to request this level')) {
				logger.error(`Username: ${this.user?.username}, rank: ${this.user?.rank}, xp: ${this.user?.xp}, level: ${level}`);
			}
			return false;
		}
		this.setUser(resp.data.user);
		if (this.user?.liveSession?.id !== resp.data.sessionId) {
			logger.error(`Live session found doesn't match returned id ${resp.data.sessionId}:\n${JSON.stringify(this.user?.liveSession, null, 4)}`);
			exec.test.abort();
			return false;
		}
		let status = this.user?.liveSession?.status;
		const start = Date.now();
		let numPolls = 0;
		while (status !== UserPlaySessionStatus.Playing) {
			if (!status) {
				logger.error(`Bad session status in requestLevel: numPolls=${numPolls}:\n${JSON.stringify(this.user, null, 4)}`);
				logger.error(`Bad session is: ${JSON.stringify(this.user?.liveSession, null, 4)}`);
				exec.test.abort();
				return false;
			}
			const elapsed = Date.now() - start;
			if (elapsed > 180000) {	// 180 seconds without a match
				logger.error(`No match after ${elapsed / 1000} secs - cancelling! status=${status}, session=\n${JSON.stringify(this.user?.liveSession, null, 4)}`);
				resp = this.postCancelRequestLevel();
				if (!resp.error || resp.error.msg !== 'User is already matched.') {
					pollingDelay();
					this.getUser();
					this.metrics.liveGameCancelRequestsCount.add(1);
					return false;
				}
				if (resp.error) {
					logger.error(resp.error.msg);
				}
			}
			pollingDelay();
			this.getUser();
			status = this.user?.liveSession?.status;
			++ numPolls;
		}
		this.opponentUsername = this.user?.liveSession?.opponentUsername;
		resp = this.findUser(this.opponentUsername);
		if (resp.error) {
			logger.error(`Error! requestLevel(${sessionType}, ${level}) finding opponent: ${resp.error.msg}`);
			return false;
		}
		delayRange(12, 13);	// Spinner animation
		while (status !== UserPlaySessionStatus.Playing) {
			pollingDelay();
			this.getUser();
			status = this.user?.liveSession?.status;
		}
		return true;
	}

	private beginRoundTimer(game: IXGame): IResponse {
		const round = game.data.currentRoundData?.roundNumber;
		if (round == null) {
			const msg = `currentRoundData.roundNumber is null: ${JSON.stringify(game, null, 4)}`;
			logger.error(msg);
			return { error: { msg } };
		}
		let resp = {} as IResponse;
		let first = true;
		while (!(resp?.data as IXGame)?.data) {
			if (!first)
				pollingDelay();
			resp = this.postGamesEvent(game.id, ClientEventType.beginRoundTimer, { round } );
			if (resp.error)
				return resp;
			first = false;
		}
		return resp;
	}

	private makeMove(game: IXGame): IResponse {
		delayRange(1, 10);	// Player thinking time
		let data;
		if (game.type === GameType.MonkeyBusiness) {
			const availableWater = game.data.player.currentRoundData.playerState.water;
			logger.trace(`availableWater=${availableWater}`);
			data = Math.round(randomInRange(0, availableWater));
			logger.debug(`Move ${data}`);
		} else if (game.type === GameType.CrystalCaverns) {
			const availableButtons = [1, 2, 3];
			logger.trace(`availableButtons=${availableButtons}`);
			const buttonIndex = Math.round(randomInRange(0, availableButtons.length - 1));
			logger.trace(`button_index=${buttonIndex}`);
			data = availableButtons[buttonIndex];
			logger.debug(`Move ${data}`);
		} else if (game.type === GameType.MagnetMadness || game.type === GameType.Blasteroids) {
			const buttons = game.data.player.currentRoundData.playerState.buttons as IGameButton[];
			const availableButtons = buttons.filter(b => b.isActive).map(b => b.value);
			logger.trace(`availableButtons=${availableButtons}`);
			const buttonIndex = Math.round(randomInRange(0, availableButtons.length - 1));
			logger.trace(`buttonIndex=${buttonIndex}`);
			data = availableButtons[buttonIndex];
			logger.debug(`Move ${data}`);
		} else {
			throw Error(`Unknown game type ${game.type} in makeMove`);
		}
		const round = game.data.currentRoundData.roundNumber;
		const resp = this.postGamesAnswer(game.id, { round, data });
		if (resp.error) {
			const e = new Error(`Error! submitting game answer: ${resp.error.msg}, code=${resp.error.code}`);
			logger.error(e.stack as string);
		}
		return resp;
	}

	private playLevel(sessionType: UserPlaySessionType, level: number): IResponse {
		let resp = {} as IResponse;
		logger.info('Play level ' + level + '...');
		if (!this.user) {
			resp.error = { msg: 'No user!' };
			logger.error(resp.error.msg as string);
			return resp;
		}

		const matchmakingStart = Date.now();
		if (!this.requestLevel(sessionType, level)) {
			// Request was cancelled because it took too long
			return { cancelled: true };
		}
		if (!this.user.liveSession || this.user.liveSession.status !== UserPlaySessionStatus.Playing || !this.user.liveSession.game) {
			resp.error = { msg: 'No live session found after requestLevel()!' };
			logger.error(resp.error.msg as string);
			return resp;
		}

		const gameId = this.user.liveSession.game;
		const gameType = this.user.liveSession.gameType;
		const gameLevel = this.user.liveSession.matchedLevel;
		this.metrics.liveGameCount.add(1, { game: gameType, level: gameLevel.toString() });
		logger.trace('type=' + gameType);

		resp = this.loadLiveGame(gameId);
		if (resp.error) {
			logger.error(resp.error.msg as string);
			return resp;
		}
		let game = resp.data as IXGame;
		delayRange(4, 5);

		this.metrics.matchmakingDelay.add(Date.now() - matchmakingStart, { game: gameType, level: gameLevel.toString() });
		const isBot = game.isBot;
		this.metrics.botsPercentage.add(isBot ? 1 : 0, { game: gameType, level: gameLevel.toString() });

		const gameStart = Date.now();
		let n = 1;
		let winStatus = game.data.gameStatus.winStatus;
		while (!winStatus) {
			let roundNumber = n;
			const roundStart = Date.now();
			resp = this.beginRoundTimer(game);
			if (resp.error)
				return resp;
			game = resp.data as IXGame;
			resp = this.makeMove(game);
			if (resp.error)
				return resp;
			game = resp.data as IXGame;
			while (roundNumber === n && !winStatus) {
				pollingDelay();
				resp = this.getGame(gameId);
				if (resp.error)
					return resp;
				game = resp.data as IXGame;
				if (game?.data) {
					roundNumber = game.data.gameStatus.roundNumber;
					winStatus = game.data.gameStatus.winStatus;
				}
			}
			this.metrics.roundDelay.add(Date.now() - roundStart, { game: gameType, level: gameLevel.toString()/*, round: n*/ });
			++n;
		}
		delayRange(15, 18);	// Finish animations
		resp = this.postGamesEvent(gameId, ClientEventType.ackResult);
		this.metrics.liveGameLength.add(Date.now() - gameStart, { game: gameType, level: gameLevel.toString() });
		logger.debug(winStatus);
		return resp;
	}

	/**
	 * Play a live 'Power Play' game
	 */
	private playRandomLevel(): IResponse {
		logger.info('Play random level...');
		if (this.user) {
			while (true) {
				const level = Math.min(Math.max(this.user.account ? Math.round(maxLevel(this.user.account) * Math.random()) : 0, 0), this.maxLevel);
				if (level < this.levels.length && this.user.rank >= this.levels[level].unlocksAtRank)
					return this.playLevel(UserPlaySessionType.Live, level);
			}
		}
		return { error: { msg: 'No user!' }} ;
	}

	private claimGoalAwards(): IResponse {
		logger.info('Claiming goal rewards...');
		let resp = {} as IResponse;
		if (this.progressTrackers) {
			const claimable = this.progressTrackers.goals?.find(t => t.id > 0 && t.state === ProgressTrackerState.Complete);
			if (claimable) {
				logger.info(`Claiming award for ${claimable.id}`);
				resp = this.claimProgressTrackerAward(claimable.id);
				if (!resp.error) {
					this.progressTrackers = resp.data as IExposedUserProgressTrackers;
					this.metrics.goalAwardsClaimedCount.add(1);
				}
			}
		}
		return resp;
	}

	private getHomeSpecialEvents(): IResponse {
		return this.getSpecialEvents();
	}

	private loadLiveGame(gameId: string): IResponse {
		delayRange(2, 3);
		let resp = this.postGamesEvent(gameId, ClientEventType.finishedLoading);
		if (resp.error)
			return resp;

		let first = true;
		while (!resp.data || !(resp.data as IXGame).data) {
			if (!first)
				pollingDelay();
			first = false;
			resp = this.getGame(gameId);
			if (resp.error)
				return resp;
		}
		this.opponentIsBot = (resp.data as IXGame)?.isBot;
		return resp;
	}

	private loadAsyncGame(gameId: string): IResponse {
		delayRange(2, 3);
		const resp = this.postGamesEvent(gameId, ClientEventType.finishedLoading);
		if (resp.error)
			return resp;
		return resp;
	}

	private unloadLiveGame(): IResponse {
		let resp = this.getConfig('towerdata');
		resp = this.getConfig('appData');
		resp = this.getUser();
		resp = this.getConfig('charitydata');
		resp = this.getSpecialEvents();
		resp = this.getUser('all');
		resp = this.findUser(this.opponentUsername);
		return resp;
	}

	private unloadAsyncGame(): IResponse {
		let resp = this.getConfig('towerdata');
		resp = this.getConfig('appData');
		resp = this.getUser();
		resp = this.getConfig('charitydata');
		resp = this.getSpecialEvents();
		resp = this.getUser('all');
		resp = this.findUser(this.opponentUsername);
		return resp;
	}

	//==========================================================================
	// Utility methods
	//==========================================================================

	private rampDown(): boolean {
		const now = Date.now();
		const elapsed = now - this.startTime;
		logger.trace('elapsedTime=' + elapsed);
		// If we're past the start of ramp-down, see if this VU should stop playing now
		if (elapsed > this.startRampDownElapsed) {
			const rampDownElapsed = elapsed - this.startRampDownElapsed;
			let vusFrac = 1 - rampDownElapsed / this.rampDownDuration;
			if (vusFrac < 0) vusFrac = 0;
			logger.trace('vusFrac=' + vusFrac + ', rampDownElapsed=' + rampDownElapsed);
			if (__VU > vusFrac * this.vusMax) {
				logger.info('Ramping down VU: ' + __VU + ', vusFrac=' + vusFrac + ', elapsed=' + elapsed);
				this.killVU(this.testDuration, this.startTime);
				return true;
			}
		}
		return false;
	}

	private killVU(testDuration: number, startTime: number): void {
		// Kill VU by sleeping past end of test
		const t = (testDuration - (Date.now() - startTime)) / 1000 * 2;
		delayRange(t, t);
	}

	private setUser(data: unknown): void {
		if (!data)
			return;
		// TODO: Parse ISO-8601 date strings into Date instances
		this.user = data as IExposedUser;
		if (this.user)
			this.user.liveSession = getLiveSession(this.user);
	}

	private hasMegaSpins(): boolean {
		const item = this.findItem(ItemType.MegaSpin);
		return item != null && item.quantity >= 100 && (!item.consumable?.nextUseTs || new Date(item.consumable.nextUseTs).getTime() <= Date.now());
	}

	private hasBasicSpins(): boolean {
		const item = this.findItem(ItemType.BasicSpin);
		return item != null && item.quantity >= 100 && (!item.consumable?.nextUseTs || new Date(item.consumable.nextUseTs).getTime() <= Date.now());
	}

	private hasAccount(min = 0): boolean {
		return (this.user?.account || 0) >= min;
	}

	private hasSecondaryAccount(min = 0): boolean {
		return (this.user?.secondaryAccount || 0) >= min;
	}

	/** Standard actions from top or bottom menu bars */
	private getMenuBarActions(totalWeight = 30): Action[] {
		return [
			new Action(totalWeight * 0.83333333333334, 'newTab', () => ActionResult.LeaveScreen),
			new Action(totalWeight * 0.1, 'settings', () => this.doSettingsScreen()),
			new Action(totalWeight * 0.066666666666667, 'walletDetails', () => this.doWalletDetailsScreen()),
		];
	}

	/**
	 * Checks if the given response inidicates that a request succeeded, or else
	 * encountered an error. In the case of an error, also prints a warning or
	 * error message and call stack, and sets an appropriate ActionResult value
	 * in checkResponseError for the caller to return.
	 * @param {IResponse} resp The response to check
	 * @param {boolean} onlyFatal If true, prints a warning instead of an error and returns false
	 * @param {Record<string, unknown>} info Additional info add to the log output
	 * @returns {boolean} true if request succeeded, else false
	 */
	private checkResponse(resp: IResponse, tag = '', onlyFatal = false, info?: Record<string, unknown>): boolean {
		if (resp.error) {
			const getInfoString = (): string => {
				const infoString = '';
				if (info)
					for (const key in info)
						infoString.concat(', ', key, '=', String(info[key]));
				return infoString;
			};
			// TODO: Add all properties of resp.error as info? (HTTP status, server error code, etc.)
			if (isFatal(resp.error)) {
				const error = new Error(`Fatal error! ${tag ? tag + ': ' : ''} ${resp.error.msg}${getInfoString()}`);
				logger.error(`${error.stack || error.message}`);
				this.checkResponseError = ActionResult.FatalError;
				return false;
			} else if (onlyFatal) {
				const error = new Error(`Warning! ${tag ? tag + ': ' : ''} ${resp.error.msg}${getInfoString()}`);
				logger.warn(`${error.stack || error.message}`);
				this.checkResponseError = ActionResult.Error;
				return true;
			} else {
				const error = new Error(`Error! ${tag ? tag + ': ' : ''} ${resp.error.msg}${getInfoString()}`);
				logger.error(`${error.stack || error.message}`);
				this.checkResponseError = ActionResult.Error;
				return false;
			}
		} else if (resp.data && typeof resp.data === 'object') {
			if (resp.data.hasOwnProperty('account') && resp.data.hasOwnProperty('secondaryAccount'))
				this.setUser(resp.data);
		}
		return true;
	}

	private findItem(itemType: ItemType): IItem|undefined {
		return this.user?.inventory?.find(p => p.itemType === itemType);
	}

	//==========================================================================
	// API request wrappers
	//==========================================================================

	private postStartup(): IResponse {
		return this.api.post('startup', { foregrounded: false, installed: false });
	}

	private postSessionStart(): IResponse {
		return this.api.post('users/session_start', {});
	}

	private postRegister(): IResponse {
		return  this.api.post('users/register', {});
	}

	private postActivate(username: string): IResponse {
		return this.api.post('users/activate', { username });
	}

	private postSetInviter(inviter: string): IResponse {
		return this.api.post('users/set_inviter', { inviter });
	}

	private postUseItem(itemType: ItemType): IResponse {
		return this.api.post('users/use_item', { itemType });
	}

	private postSetBalance(amount: number): IResponse {
		return this.api.post('users/set_balance', { amount });
	}

	private postSetSecondaryBalance(amount: number): IResponse {
		return this.api.post('users/set_secondary_balance', { amount });
	}

	private postSetXp(xp: number): IResponse {
		return this.api.post('users/set_xp', { xp });
	}

	private postAddItem(item: string, quantity: number): IResponse {
		return this.api.post('users/add_item', { item, quantity });
	}

	private postUnlockGame(game: string): IResponse {
		return this.api.post('users/unlock_game', { game });
	}

	private getConfig(type: string): IResponse {
		return this.api.get(`config/${type}`);
	}

	private getUser(projection = 'standard'): IResponse {
		const resp = this.api.get(`users?projection=${projection}`);
		this.setUser(resp.data);
		return resp;
	}

	private findUser(username: string|undefined, allowBots = true, projection = 'brief', exact = true): IResponse {
		if (!username) {
			throw new Error(`Error! username is ${username}`);
		}
		return this.api.get(`users/find?username=${username}&allowBots=${allowBots ? 'True' : 'False'}&projection=${projection}&exact=${exact ? 'True' : 'False'}`);
	}

	private findChallengees(): IResponse {
		return this.api.get('users/find_challengees');
	}

	private getStats(opponentUsername: string|undefined): IResponse {
		if (!opponentUsername) {
			throw new Error(`Error! username is ${opponentUsername}`);
		}
		return this.api.get(`users/find_stats?username=${opponentUsername}`);
	}

	private postCancelRequestLevel(): IResponse {
		return this.api.post('games/cancel_request_level', {});
	}

	private getGame(gameId: string): IResponse {
		return this.api.get(`games/${gameId}`);
	}

	private postGamesEvent(gameId: string, type: ClientEventType, data?: unknown): IResponse {
		return this.api.post(`games/${gameId}/event`, { event: { type, ...(data != null ? { data } : {}) } });
	}

	private postGamesAnswer(gameId: string, answer: unknown): IResponse {
		return this.api.post(`games/${gameId}/answer`, { answer });
	}

	private getGamesWatch(gameId: string): IResponse {
		return this.api.get(`games/${gameId}/watch`);
	}

	private getLeaderboard(type: LeaderboardType, id?: string): IResponse {
		return this.api.get(`users/leaderboard?type=${type}${id ? ('&id=' + id) : ''}&offset=0&limit=40`);
	}

	private getActivityFeed(type: FeedType, id = ''): IResponse {
		return this.api.get(`feeds/activity?type=${type}&id=${id}&offset=0&limit=40`);
	}

	private getSpecialEvents(): IResponse {
		return this.api.get(`special_events`);
	}

	private getProgressTrackers(): IResponse {
		return this.api.get(`users/progress_trackers`);
	}

	private claimProgressTrackerAward(id: number): IResponse {
		return this.api.post(`users/progress_trackers/claim`, { progressTrackerId: id });
	}

	private getRecentGames(): IResponse {
		return this.api.get('users/stats');
	}

	private postRequestMatch(type: UserPlaySessionType, level: number, username: string|undefined): IResponse {
		return this.api.post('games/request_match', {
			type,
			level,
			username,
			strictMatching: false,
			botsOnly: false,
			gameType: null
		});
	}

	private postAcceptMatch(sessionId: string): IResponse {
		return this.api.post('games/accept_match', { sessionId });
	}

	private postDeclineMatch(sessionId: string): IResponse {
		return this.api.post('games/decline_match', { sessionId });
	}

	private postAcknowledgeMatch(sessionId: string): IResponse {
		return this.api.post('games/acknowledge_match', { sessionId });
	}

	private postSpecialEventsClaim(eventId: string, claimant: string): IResponse {
		return this.api.post('special_events/claim', { eventId, claimant });
	}

	private postSpecialEventsJoin(eventId: string, inviteCode?: string): IResponse {
		return this.api.post('special_events/join', { eventId, ...(inviteCode ? { inviteCode } : {}) });
	}

	private postSpecialEventsRejoin(eventId: string): IResponse {
		return this.api.post('special_events/rejoin', { eventId });
	}

	private postCashoutStart(): IResponse {
		return this.api.post('users/cashout_start', {});
	}

	private postCashoutFinish(charityPercent: number, desiredCharityAmount: number, desiredPlayerAmount: number, payee: string): IResponse {
		return this.api.post('users/cashout_finish', { charityPercent, desiredCharityAmount, desiredPlayerAmount, payee });
	}

	private postAdsStart(): IResponse {
		return this.api.post('ads/start', {});
	}

	private postAdsFinish(): IResponse {
		return this.api.post('ads/finish', {});
	}

	private postUpdateProfile(value: { [key in keyof IUserProfile]? : unknown }): IResponse {
		return this.api.post('users', { profile: value });
	}

	private getActiveCount(): IResponse {
		return this.api.get('users/active_count');
	}

	private getSpecialEvent(id: string): IResponse {
		return this.api.get(`special_events/${id}`);
	}

	private getInviteOnlySpecialEvent(accessCode: string): IResponse {
		return this.api.get(`special_events/invite_only/${accessCode}`);
	}
}

//==============================================================================
// Utility functions
//==============================================================================

function pollingDelay(): void {
	delayRange(2, 2.25);
}

function getLiveSession(user: IXUser): IExposedUserPlaySession|undefined {
	return user?.sessions?.find(s => s.isLive);
}

function getAsyncSessionAgainst(user: IXUser, opponentUsername: string|undefined, onlyRequiresAction = false, onlyStatus?: UserPlaySessionStatus): IExposedUserPlaySession|undefined {
	return user?.sessions?.find(s => !s.isLive && s.opponentUsername === opponentUsername && (!onlyRequiresAction || s.requiresAction) && (!onlyStatus || s.status === onlyStatus));
}

function getAsyncSessionWithStatus(user: IXUser, status: UserPlaySessionStatus, onlyRequiresAction = false): IExposedUserPlaySession|undefined {
	return user?.sessions?.find(s => !s.isLive && s.status === status && (!onlyRequiresAction || s.requiresAction));
}

function getAsyncSessionForSpecialEvent(user: IXUser, specialEventId: string): IExposedUserPlaySession|undefined {
	return user?.sessions?.find(s => !s.isLive && s.specialEventData?.id === specialEventId);
}

function backoff(maxTime: number): void {
	const sleepTime = maxTime * Math.random();
	logger.warn('Backing off VU: ' + __VU + ', ' + sleepTime + ' seconds');
	delayRange(sleepTime, sleepTime);
}

function shouldLeaveScreen(result: ActionResult): boolean {
	return result === ActionResult.LeaveScreen
		|| result === ActionResult.GoToMatchups
		|| result === ActionResult.ExitApp
		|| result === ActionResult.FatalError
		|| result === ActionResult.Done;
}

function shouldExitIteration(result: ActionResult): boolean {
	return result === ActionResult.ExitApp
		|| result === ActionResult.FatalError
		|| result === ActionResult.Done;
}

function isFatal(errorData: IResponseErrorData|undefined): boolean {
	// TODO: List of server-returned errors that are fatal. Mostly those might
	// be things like banned users or expired auths, etc.
	return errorData != null && (errorData.status == null || errorData.code == null);	// Client-side errors
}

function toActionResult(resp: IResponse): ActionResult {
	if (isFatal(resp.error))
		return ActionResult.FatalError;
	else if (resp.error)
		return ActionResult.Error;
	else
		return ActionResult.OK;
}

function okOrError(resp: IResponse|undefined): ActionResult {
	return isFatal(resp?.error) ? ActionResult.FatalError : ActionResult.OK;
}

function okOrBackOrError(resp: IResponse|undefined, backWeight: number): ActionResult {
	if (isFatal(resp?.error))
		return ActionResult.FatalError;
	const chance = Math.random();
	return chance <= backWeight ? ActionResult.LeaveScreen : ActionResult.OK;
}

// Player thinking time
function think(previousResult: ActionResult): void {
	if (previousResult !== ActionResult.Skipped)
		delayRange(1, 20);
}

function maxLevel(value: number|undefined): number {
	if (!value)
		return value || 0;
	return Math.floor(Math.log10(value) / Math.log10(2) + 1);
}

function specialEventEqual(a: IExposedSpecialEvent, b: IExposedSpecialEvent): boolean {
	const aHasInviteCode = a.hasInviteCode != null ? a.hasInviteCode : a.hasOwnProperty('inviteCode');
	return a.type === b.type
		&& a.name === b.name
		&& a.start === b.start
		&& a.close === b.close
		&& a.joinType === b.joinType
		&& a.joinCost === b.joinCost
		&& a.joinCurrency === b.joinCurrency
		&& a.isFeatured === b.isFeatured
		&& aHasInviteCode === b.hasInviteCode
		&& a.isHidden === b.isHidden
	;
}
