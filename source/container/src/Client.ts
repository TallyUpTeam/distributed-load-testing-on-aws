import exec from 'k6/execution';
import { API } from './API';
import { config } from './Config';
import { Logger } from './Logger';
import { Metrics } from './Metrics';
import { IResponse, IResponseErrorData, Utils } from './Utils';
import ErrCode from './tallyup-server/errors/ErrCode';
import { IExposedUser, IExposedUserPlaySession, IExposedUserProgressTrackers } from './tallyup-server/dtos/types/ExposedUserTypes';
import { CurrencyType, UserPlaySessionStatus, UserQueueStatus, UserSpecialEventStatus } from './tallyup-server/models/types/UserTypes';
import { IExposedGame, IExposedGameData } from './tallyup-server/dtos/types/ExposedGameTypes';
import { ClientEventType, GameStatus, GameType, IGameButton } from './tallyup-server/models/types/BaseGameTypes';
import { Action, ActionResult, ActionSet } from './Action';
import { LeaderboardType } from './tallyup-server/models/types/LeaderboardTypes';
import { FeedType } from './tallyup-server/models/types/FeedItemTypes';
import { ProgressTrackerState, UserPlaySessionType } from './tallyup-server/models/types/UserTypes';
import { PowerUpType } from './tallyup-server/models/PowerUp';
import { IExposedSpecialEvent, IExposedSpecialEventUserSequence } from './tallyup-server/dtos/types/ExposedSpecialEventTypes';
import { IExposedPublicUsersBrief } from './tallyup-server/dtos/types/ExposedPublicUserTypes';

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
	}

	public session(): void {
		logger.debug('startTime=' + this.startTime + ', startRampDownElapsed=' + this.startRampDownElapsed + ', rampDownDuration=' + this.rampDownDuration + ', vusMax=' + this.vusMax);

		if (shouldExitIteration(this.doLoadingScreen()))
			return;
		if (shouldExitIteration(this.doTowerScreen()))
			return;

		const actions = new ActionSet('session', [
			new Action(5, 'exit', () => {
				// Stop playing for a while
				logger.info('Exiting session...');
				delayRange(60, 120);
				return ActionResult.ExitApp;
			}),
			new Action(10, 'activityScreen', () => this.doActivityScreen()),
			new Action(10, 'arcadeScreen', () => this.doArcadeScreen()),
			new Action(10, 'towerScreen', () => this.doTowerScreen()),
			this.playAsync ? [
				new Action(10, 'eventsScreen', () => this.doEventsScreen()),
				new Action(10, 'matchupsScreen', () => this.doMatchupsScreen())
			] : null
		]);

//		ActionSet.forceActions(['towerScreen.playRandom', 'pvpScreen?.startChallenge']);
		let result = this.doTowerScreen();

		while (!this.rampDown()) {
			if (this.playAsync && result === ActionResult.GoToMatchups)
				result = actions.dispatchAction('matchupsScreen');
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
		const resp = this.sessionStart();
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
		this.getConfig('towerdata');
		this.getConfig('appData');
		this.getUser();
		this.getConfig('charitydata');
		return ActionResult.OK;
	}

	private doSettingsScreen(): ActionResult {
		this.metrics.settingsScreenCount.add(1, { });
		const actions = new ActionSet('activityScreen', [
			new Action(25, 'back', () => ActionResult.LeaveScreen),
			new Action(10, 'cashOut', () => doRequests(this.cashOut(), this.hasAccount(1000))),
			new Action(25, 'setInviter', () => doRequests(this.setInviter(exec.instance.vusActive))),
			new Action(25, 'recentGames', () => doRequests(this.getRecentGames())),
			new Action(25, 'changeMatchmaking', () => doRequests(this.postChangeMatchmaking()))
		]);
		let result = ActionResult.OK;
		const doSingleAction = true;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (doSingleAction || shouldLeaveScreen(result)) {
				// Returning LeaveScrean would change tabs on parent screen and we don't want that
				return result === ActionResult.LeaveScreen ? ActionResult.OK : result;
			}
		}
		return ActionResult.Done;
	}

	private doActivityScreen(): ActionResult {
		this.metrics.activityScreenCount.add(1, { });
		const doFeed = (type: FeedType): ActionResult => doRequests(this.getActivityFeed(type));	// TODO: Watch game replay!
		const doLeaderboard = (type: LeaderboardType): ActionResult => doRequests(this.getLeaderboard(type));
		const actions = new ActionSet('activityScreen', [
			this.getMenuBarActions(46),
			new Action(6, 'feed', () => doFeed(FeedType.Winnings)),
			new Action(6, 'winningsToday', () => doLeaderboard(LeaderboardType.WinningsToday)),
			new Action(6, 'winningsYesterday', () => doLeaderboard(LeaderboardType.WinningsYesterday)),
			new Action(6, 'winningsThisWeek', () => doLeaderboard(LeaderboardType.WinningsThisWeek)),
			new Action(6, 'winningsLastWeek', () => doLeaderboard(LeaderboardType.WinningsLastWeek)),
			new Action(6, 'highestBalance', () => doLeaderboard(LeaderboardType.HighestBalance)),
			new Action(6, 'currentBalance', () => doLeaderboard(LeaderboardType.CurrentBalance)),
			new Action(6, 'mostDonated', () => doLeaderboard(LeaderboardType.MostDonated)),
			new Action(6, 'surge', () => doLeaderboard(LeaderboardType.SurgeScore))
		]);
		let result = doRequests(this.getActivityFeed(FeedType.Winnings));
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

	private doArcadeScreen(): ActionResult {
		this.metrics.arcadeScreenCount.add(1, { });
		const actions = new ActionSet('arcadeScreen', [
			this.getMenuBarActions(),
			new Action(35, 'claim', () => doRequests(this.claimGoalAwards())),
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

	private doTowerScreen(): ActionResult {
		this.metrics.towerScreenCount.add(1, { });
		const actions = new ActionSet('towerScreen', [
			this.getMenuBarActions(),
			new Action(70, 'playRandom', () => this.doPlayRandomTowerLevel()),
		]);
		this.updateSurgePanel();
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			// TODO: Spin if no balance - exit if no spins or power ups (+ ad start and finish)
			if (this.user && this.user.account < 1) {
				if (this.user.spinsRemaining < 1 && !this.hasMegaSpins()) {
					this.metrics.noSpinsCount.add(1);
					logger.error('No spinsRemaining!');
					return ActionResult.ExitApp;
				}
				const resp = this.towerSpinner();
				if (resp.error) {
					if (resp.error.msg)
						logger.error(resp.error.msg);
					delay(300); 	// 5 min cool down before retrying
					return ActionResult.ExitApp;
				}
			}
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result))
				return result;
			if (result !== ActionResult.Skipped) {
				this.updateSurgePanel();
				this.getLeaderboard(LeaderboardType.SurgeScore);
			}
		}
		return ActionResult.Done;
	}

	private doEventsScreen(): ActionResult {
		if (!this.playAsync)
			return ActionResult.Skipped;
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
			if (!event && data.specialEvents?.current && data.specialEvents.current.length) {
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
		const actions = new ActionSet('eventsScreen', [
			this.getMenuBarActions(),
			new Action(20, 'idle', () => doIdle()),
			new Action(50, 'selectEventDetails', () => doSelectEventDetails())
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

	private doEventDetailScreen(parentData: ISpecialEventScreenData, specialEvent: IExposedSpecialEvent): ActionResult {
		this.metrics.eventDetailsScreenCount.add(1, { });
		let selectedTab: 'leaderboard'|'feed' = 'leaderboard';
		const update = (): IResponse => {
			let resp = this.getUser();
			if (isFatal(resp.error))
				return resp;
			resp = this.getSpecialEvents();
			if (isFatal(resp.error))
				return resp;
			if (!resp.error) {
				// Update the eventScreen's list (this is effectively like updating a pass-by-reference variable)
				parentData.specialEvents = resp.data as IExposedSpecialEventUserSequence;
				// Update our target event
				// Prioritized actions - maybe randomize using Action dispatch?
				let updatedEvent = parentData.specialEvents.last?.find(e => e.id === specialEvent.id);
				if (!updatedEvent)
					updatedEvent = parentData.specialEvents.current?.find(e => e.id === specialEvent.id);
				if (!updatedEvent)
					updatedEvent = parentData.specialEvents.next?.find(e => e.id === specialEvent.id);
				if (!updatedEvent)
					return { error: { msg: `Cannot find specialEvent ${specialEvent.id} in eventDetailsScreen after update!`}};
				specialEvent = updatedEvent;
			}
			if (selectedTab === 'leaderboard') {
				resp = this.getLeaderboard(LeaderboardType.AdHocScore, specialEvent.id);
			} else {
				resp = this.getActivityFeed(FeedType.AdHoc, specialEvent.id);
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
			const resp = this.getActivityFeed(FeedType.AdHoc, specialEvent.id);
			if (isFatal(resp.error))
				return ActionResult.FatalError;
			selectedTab = 'feed';
			return ActionResult.OK;
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
						return this.doAsyncMakeMove(session);
					} else if (session.status !== UserPlaySessionStatus.Completed) {
						// See result
						return this.doAsyncSeeResult(session);
					}
				} else
					return ActionResult.Skipped;	// Waiting for round to begin or opponent to make a move - can't do anything
			case UserSpecialEventStatus.Won:
			case UserSpecialEventStatus.RunnerUp:// Claim reward
				return this.doClaimSpecialEventPrize(specialEvent);
			case UserSpecialEventStatus.Uninvolved:
				return this.doJoinSpecialEvent(specialEvent);
			case UserSpecialEventStatus.Eliminated:
				return this.doRejoinSpecialEvent(specialEvent);	// If rejoin cost and window not closed yet, then rejoin
			default:
				return ActionResult.Skipped;	// Nothing to do
			}
		};
		const actions = new ActionSet('eventDetailsScreen', [
			new Action(25, 'back', () => ActionResult.LeaveScreen),
			new Action(5, 'leaderboard', () => doLeaderboardTab()),
			new Action(5, 'feed', () => doFeedTab()),
			new Action(10, 'idle', () => { delayRange(5, 45); return toActionResult(update()); }),	// Like a timer for periodic updates when idle
			new Action(55, 'eventAction', () => doMain())
		]);
		update();
		let result = ActionResult.OK;
		while (!this.rampDown()) {
			think(result);
			result = actions.dispatch();
			if (shouldLeaveScreen(result)) {
				// Returning LeaveScrean would change tabs on parent screen and we don't want that
				return result === ActionResult.LeaveScreen ? ActionResult.OK : result;
			}
			if (isFatal(update().error))
				return ActionResult.FatalError;
		}
		return ActionResult.Done;
	}

	private doMatchupsScreen(): ActionResult {
		if (!this.playAsync)
			return ActionResult.Skipped;
		this.metrics.matchupsScreenCount.add(1, { });
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
			const opponentUsername = Utils.getUsernameFromNumber(Math.max(1, n - 1, Math.random()));
			return this.doPvPScreen(opponentUsername);
		};
		const doMain = (): ActionResult => {
			// Prioritized actions - maybe randomize using Action dispatch?
			let session = this.user?.sessions?.find(s => !s.isLive && s.requiresAction && s.status === UserPlaySessionStatus.Playing);
			if (session) {
				return this.doAsyncMakeMove(session);	// TAKE TURN
			}
			session = this.user?.sessions?.find(s => !s.isLive && s.requiresAction && s.status === UserPlaySessionStatus.Completed);
			if (session) {
				return this.doAsyncSeeResult(session);	// SEE RESULT
			}
			session = this.user?.sessions?.find(s => !s.isLive && s.requiresAction && s.status === UserPlaySessionStatus.ChallengeReceived);
			if (session) {
				return this.doPvPScreen(session.opponentUsername);	// VIEW
			}
			session = this.user?.sessions?.find(s => !s.isLive && s.requiresAction && s.status === UserPlaySessionStatus.ChallengeRejected);
			if (session) {
				return this.doAsyncAcknowledgeMatch(session);	// OK (ack declined)
			}
			// Their move - nothing to do
			const choice = Math.round(100 * Math.random());
			if (choice <= 50 && challengees.users.length) {
				// Pick a challengee
				return this.doPvPScreen(challengees.users[Math.floor(Math.random() * challengees.users.length)].username);
			}
			return ActionResult.OK;
		};
		const actions = new ActionSet('matchupsScreen', [
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
				mainAction = new Action(75, 'move', () => this.doAsyncMakeMove(session));
				break;
			case UserPlaySessionStatus.ChallengeRejected:
			case UserPlaySessionStatus.Completed:
				mainAction = new Action(75, 'startChallenge', () => this.doAsyncIssueChallenge(opponentUsername));
				break;
			default:
				// No action possible - button would be grayed out
			}
		} else {
			mainAction = new Action(75, 'startChallenge', () => this.doAsyncIssueChallenge(opponentUsername));
		}
		const actions = new ActionSet('pvpScreen', [
			new Action(25, 'back', () => ActionResult.OK),
			mainAction
		]);
		let resp = this.findUser(this.opponentUsername);
		if (isFatal(resp.error))
			return ActionResult.FatalError;
		if (resp.error)
			return ActionResult.Error;
		resp = this.getStats(this.opponentUsername);
		if (isFatal(resp.error))
			return ActionResult.FatalError;
		return actions.dispatch();
	}

	//==========================================================================
	// Screen action helpers
	//==========================================================================

	private doPlayRandomArcadeLevel(): ActionResult {
		let resp = this.playLevel([ 0 ]);	// No need to select a game type we have unlocked - just let server choose
		if (!resp.error) {
			resp = this.unloadLiveGame();
			const actions = new ActionSet('arcadeGameOver', [
				!this.opponentIsBot ? new Action(10, 'matchupAgainst', () => this.doPvPScreen(this.opponentUsername)) : null,
				new Action(90, 'backToArcade', () => ActionResult.OK)
			]);
			return actions.dispatch();
		}
		if (resp.cancelled)
			return ActionResult.OK;
		return ActionResult.FatalError;
	}

	private doPlayRandomTowerLevel(): ActionResult {
		if (!this.hasAccount(1))
			return ActionResult.Skipped;
		let resp = this.playRandomLevel();
		if (!resp.error) {
			resp = this.unloadLiveGame();
			resp = this.getLeaderboard(LeaderboardType.SurgeScore);
			const actions = new ActionSet('towerGameOver', [
				!this.opponentIsBot ? new Action(10, 'matchupAgainst', () => this.doPvPScreen(this.opponentUsername)) : null,
				new Action(90, 'backToTower', () => ActionResult.OK)
			]);
			return actions.dispatch();
		}
		if (resp.cancelled)
			return ActionResult.OK;
		return ActionResult.FatalError;
	}

	private doAsyncIssueChallenge(opponentUsername: string|undefined): ActionResult {
		const level = Math.max(this.user?.account ? Math.round(maxLevel(this.user.account) * Math.random()) : 0, 0);
		logger.debug(`Issuing challenge to ${opponentUsername} at level ${level}...`);
		let resp = this.postRequestMatch(UserPlaySessionType.Challenge, level, opponentUsername);
		if (resp.error) {
			logger.error(`Error! doAsyncIssueChallenge(${opponentUsername}): request_match: ${resp.error.msg}`);
			return ActionResult.Error;
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
		if (resp.error) {
			logger.error(`Error! doAsyncIssueChallenge(${opponentUsername}): loadAsyncGame(${session.game}): ${resp.error}`);
			return ActionResult.Error;
		}
		const game = resp.data as IXGame;
		const gameType = game.type;
		resp = this.beginRoundTimer(game);
		if (resp.error) {
			logger.error(`Error! doAsyncIssueChallenge(${opponentUsername}): beginRoundTimer(${session.game}): ${resp.error.msg}`);
			return ActionResult.Error;
		}
		// 10% chance to return without making 1st move?
		// Play 1st move
		resp = this.makeMove(game);
		if (resp.error) {
			logger.error(`Error! doAsyncIssueChallenge(${opponentUsername}): makeMove(${session.game}): ${resp.error.msg}`);
			return ActionResult.Error;
		}
		this.unloadAsyncGame();
		this.metrics.asyncGameStarts.add(1, { game: gameType, level: session.requestedLevel .toString() });
		return toActionResult(resp);
	}

	private doAsyncAcceptChallenge(session: IExposedUserPlaySession): ActionResult {
		const resp = this.postAcceptMatch(session.id);
		if (resp.error) {
			logger.error(`Error! doAsyncAcceptChallenge(${session.id}): accept_match: ${resp.error.msg}`);
			return ActionResult.Error;
		}
		this.metrics.asyncGameAccepts.add(1, { game: session.gameType, level: session.requestedLevel .toString() });
		return ActionResult.OK;
	}

	private doAsyncDeclineChallenge(session: IExposedUserPlaySession): ActionResult {
		const resp = this.postDeclineMatch(session.id);
		if (resp.error) {
			logger.error(`Error! doAsyncDeclineChallenge(${session.id}): decline_match: ${resp.error.msg}`);
			return ActionResult.Error;
		}
		this.metrics.asyncGameDeclines.add(1, { game: session.gameType, level: session.requestedLevel .toString() });
		return ActionResult.OK;
	}

	private doAsyncMakeMove(session: IExposedUserPlaySession): ActionResult {
		let resp = this.loadAsyncGame(session.game);
		if (resp.error) {
			logger.error(`Error! doAsyncMakeMove(${session.id}): loadAsyncGame: ${resp.error.msg}`);
			return ActionResult.Error;
		}
		const game = resp.data as IXGame;
		// 10% chance to return without making move?
		if (game?.status === GameStatus.gameComplete) {
			resp = this.postGamesEvent(game.id, ClientEventType.ackResult);
			resp = this.postAcknowledgeMatch(session.id);
			if (!resp.error) {
				this.metrics.asyncGameCompletes.add(1, { game: (resp.data as IXGame).type, level: session.requestedLevel.toString() });
			}
		} else {
			resp = this.beginRoundTimer(resp.data as IXGame);
			resp = this.makeMove(resp.data as IXGame);
			if (!resp.error) {
				this.metrics.asyncGameMoves.add(1, { game: (resp.data as IXGame).type, level: session.requestedLevel.toString() });
			}
		}
		resp = this.unloadAsyncGame();
		if (game?.status === GameStatus.gameComplete) {
			const actions = new ActionSet('arcadeGameOver', [
				!this.opponentIsBot ? new Action(10, 'matchupAgainst', () => this.doPvPScreen(session.opponentUsername)) : null,
				new Action(90, 'backToEvents/Matchups', () => ActionResult.OK)
			]);
			return actions.dispatch();
		}
		return ActionResult.OK;
	}

	private doAsyncSeeResult(session: IExposedUserPlaySession): ActionResult {
		let resp = this.loadAsyncGame(session.game);
		if (resp.error) {
			logger.error(`Error! doAsyncMakeMove(${session.id}): loadAsyncGame: ${resp.error.msg}`);
			return ActionResult.Error;
		}
		const game = resp.data as IXGame;
		resp = this.postGamesEvent(game.id, ClientEventType.ackResult);
		if (!resp.error) {
			this.metrics.asyncGameCompletes.add(1, { game: (resp.data as IXGame).type, level: session.requestedLevel.toString() });
		}
		resp = this.postAcknowledgeMatch(session.id);
		resp = this.unloadAsyncGame();
		if (game?.status === GameStatus.gameComplete) {
			const actions = new ActionSet('arcadeGameOver', [
				!this.opponentIsBot ? new Action(10, 'matchupAgainst', () => this.doPvPScreen(session.opponentUsername)) : null,
				new Action(90, 'backToEvents/Matchups', () => ActionResult.OK)
			]);
			return actions.dispatch();
		}
		return ActionResult.FatalError;
	}

	private doAsyncAcknowledgeMatch(session: IExposedUserPlaySession): ActionResult {
		const resp = this.postAcknowledgeMatch(session.id);
		if (resp.error) {
			logger.error(`Error! doAsyncAcknowledgeMatch(${session.id}): postAcknowledgeMatch: ${resp.error.msg}`);
			return ActionResult.Error;
		}
		return ActionResult.OK;
	}

	private doClaimSpecialEventPrize(specialEvent: IExposedSpecialEvent): ActionResult {
		const resp = this.postSpecialEventsClaim(specialEvent.id, `${this.user?.username}@loadtest.tallyup.com`);
		return toActionResult(resp);
	}

	private doJoinSpecialEvent(specialEvent: IExposedSpecialEvent): ActionResult {
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
		const resp = this.postSpecialEventsJoin(specialEvent.id);
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
		return toActionResult(resp);
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
		return sessionResp;
	}

	private setInviter(vusMax: number): IResponse {
		if (this.user && !this.user.inviteData.invited) {
			logger.info('Set inviter...');
			let attempts = 10;
			while (attempts-- > 0) {
				const n = 1 + Math.round((vusMax - 1) * Math.random());
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
		if ((resp?.data as Record<string, unknown>)?.isAllowed) {
			const availableBalance = this.user.account;
			const charityPercent = 10 + Math.round(90 * Math.random());
			const charityAmount = Math.round(availableBalance * (charityPercent / 100));
			const friendPercent = 10;
			const inviterAmount = resp.hasInviter ? Math.round((availableBalance - charityAmount) * (friendPercent / 100)) : 0;
			const playerAmount = availableBalance - charityAmount - inviterAmount;
			delayRange(1, 30);
			resp = this.postCashoutFinish(charityPercent, charityAmount, inviterAmount, playerAmount,`fake_${this.user?.phone.slice(2)}@tallyup.com`);
			if (!resp.error)
				this.setUser(resp.data);
		}
		return resp;
	}

	private towerSpinner(): IResponse {
		const choice = Math.round(100 * Math.random());
		let resp = this.postAdsStart();
		if (resp.error)
			return resp;
		logger.debug('Watching ad...');
		delayRange(5, 35);
		resp = this.postAdsFinish();
		if (resp.error)
			return resp;
		if (this.hasMegaSpins() && (choice > 50 || !this.user?.spinsRemaining)) {
			logger.debug('Tower start using MegaSpin...');
			resp = this.postAwardTokens(PowerUpType.TowerJump);
			if (!resp.error)
				this.metrics.megaSpinCount.add(1);
		} else if (this.user && this.user.spinsRemaining > 0) {
			logger.debug('Tower start using basic spin...');
			resp = this.postAwardTokens();
			if (!resp.error)
				this.metrics.basicSpinCount.add(1);
		}
		if (!resp.error)
			this.setUser(resp.data);
		return resp;
	}

	private requestLevel(levels: number[]): boolean {
		let resp = this.postRequestLevels(levels, false);
		let status = this.user?.liveSession?.status;
		const start = Date.now();
		while (status !== UserPlaySessionStatus.Confirmed) {
			const elapsed = Date.now() - start;
			if (elapsed > 180000) {	// 180 seconds without a match
				logger.error(`No match: elapsed=${elapsed}, status=${status}\n${JSON.stringify(this.user?.liveSession)}`);
				resp = this.postCancelRequestLevels();
				if (!resp.error || resp.error.msg !== 'User is already matched.') {
					pollingDelay();
					this.getUser();
					return false;
				}
				if (resp.error) {
					logger.error(resp.error.msg);
				}
			}
			pollingDelay();
			this.getUser();
			status = this.user?.liveSession?.status;
		}
		this.opponentUsername = this.user?.liveSession?.opponentUsername;
		this.findUser(this.opponentUsername);
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
		return resp;
	}

	private playLevel(levels: number[]): IResponse {
		let resp = {} as IResponse;
		logger.info('Play levels ' + levels + '...');
		if (!this.user) {
			resp.error = { msg: 'No user!' };
			logger.error(resp.error.msg as string);
			return resp;
		}

		const matchmakingStart = Date.now();
		if (!this.requestLevel(levels)) {
			// Request was cancelled because it took too long
			return { cancelled: true };
		}
		if (!this.user.liveSession || this.user.liveSession.status !== UserPlaySessionStatus.Playing || !this.user.liveSession.game) {
			resp.error = { msg: 'No live session found after requestLevel()!' };
			logger.error(resp.error.msg as string);
			return resp;
		}

		const gameId = this.user.liveSession.game;
		const type = this.user.liveSession.gameType;
		const gameLevel = this.user.liveSession.matchedLevel;
		this.metrics.liveGameCount.add(1, { game: type, level: gameLevel.toString() });
		logger.trace('type=' + type);

		resp = this.loadLiveGame(gameId);
		if (resp.error) {
			logger.error(resp.error.msg as string);
			return resp;
		}
		let game = resp.data as IXGame;
		delayRange(4, 5);

		this.metrics.matchmakingDelay.add(Date.now() - matchmakingStart, { game: type, level: gameLevel.toString() });
		const isBot = game.isBot;
		this.metrics.botsPercentage.add(isBot ? 1 : 0, { game: type, level: gameLevel.toString() });

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
			this.metrics.roundDelay.add(Date.now() - roundStart, { game: type, level: gameLevel.toString()/*, round: n*/ });
			++n;
		}
		delayRange(15, 18);	// Finish animations
		resp = this.postGamesEvent(gameId, ClientEventType.ackResult);
		this.metrics.liveGameLength.add(Date.now() - gameStart, { game: type, level: gameLevel.toString() });
		logger.debug(winStatus);
		return resp;
	}

	/**
	 * Play either a live tower or arcade level game
	 */
	private playRandomLevel(): IResponse {
		logger.info('Play random level...');
		if (this.user) {
			const level = Math.max(this.user.account ? Math.round(maxLevel(this.user.account) * Math.random()) : 0, 0);
			return this.playLevel([level]);
		}
		return { error: { msg: 'No user!' }} ;
	}

	private claimGoalAwards(): IResponse {
		logger.info('Claiming goal rewards...');
		let resp = {} as IResponse;
		if (this.progressTrackers) {
			const claimable = this.progressTrackers.goals.find(t => t.state === ProgressTrackerState.Complete);
			if (claimable) {
				logger.info(`Claiming award for ${claimable.id}`);
				resp = this.claimProgressTrackerAward(claimable.id);
				if (!resp.error) {
					this.progressTrackers = resp.data as IExposedUserProgressTrackers;
				}
			}
		}
		return resp;
	}

	private updateSurgePanel(): IResponse {
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
		const item = this.user?.powerUps?.find(p => p.type === PowerUpType.TowerJump);
		return item != null && item.qty > 0 && (item?.nextAvailableUseTs?.getTime() || 0) <= Date.now();
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
			new Action(totalWeight * 0.066666666666667, 'useMegaSpin', () => doRequests(this.megaSpin(), this.hasMegaSpins()))
		];
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
		return  this.api.post('users/register', { inviteCode: '0PENUP' });
	}

	private postActivate(username: string): IResponse {
		return this.api.post('users/activate', { username });
	}

	private postSetInviter(inviter: string): IResponse {
		return this.api.post('users/set_inviter', { inviter });
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
		return this.api.get(`users/find?username=${username}&allowBots=${allowBots ? 'True' : 'False'}&projection=${projection}&exact=${exact ? 'True' : 'False'}`);
	}

	private findChallengees(): IResponse {
		return this.api.get('users/find_challengees');
	}

	private getStats(opponentUsername: string|undefined): IResponse {
		return this.api.get(`users/find_stats?username=${opponentUsername}`);
	}

	private postRequestLevels(levels: number[], onlyBots = false): IResponse {
		return this.api.post('games/request_levels', { game_level: levels, only_bots: onlyBots });	// eslint-disable-line @typescript-eslint/naming-convention
	}

	private postCancelRequestLevels(): IResponse {
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

	private getLeaderboard(type: LeaderboardType, id?: string): IResponse {
		return this.api.get(`users/leaderboard?type=${type}${id ? ('%' + id) : ''}&offset=0&limit=40`);
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

	private postSpecialEventsJoin(eventId: string): IResponse {
		return this.api.post('special_events/join', { eventId });
	}

	private postSpecialEventsRejoin(eventId: string): IResponse {
		return this.api.post('special_events/rejoin', { eventId });
	}

	private postCashoutStart(): IResponse {
		return this.api.post('users/cashout_start', {});
	}

	private postCashoutFinish(charityPercent: number, desiredCharityAmount: number, desiredInviterAmount: number, desiredPlayerAmount: number, payee: string): IResponse {
		return this.api.post('users/cashout_finish', { charityPercent, desiredCharityAmount, desiredInviterAmount, desiredPlayerAmount, payee });
	}

	private postAdsStart(): IResponse {
		return this.api.post('ads/start', {});
	}

	private postAdsFinish(): IResponse {
		return this.api.post('ads/finish', {});
	}

	private postAwardTokens(usePowerUp?: PowerUpType): IResponse {
		return this.api.post('users/award_tokens', { usePowerUp: usePowerUp || null });
	}

	private postChangeMatchmaking(): IResponse {
		// We're just simulating request load on the server, so only toggle expanded off or on
		return this.api.post('users', { profile: { strictMatchmakingMode: !this.user?.profile?.strictMatchmakingMode }});
	}

	private megaSpin(): IResponse {
		return this.postAwardTokens(PowerUpType.TowerJump);
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

function getAsyncSessionAgainst(user: IXUser, opponentUsername: string|undefined): IExposedUserPlaySession|undefined {
	return user?.sessions?.find(s => !s.isLive && s.opponentUsername === opponentUsername);
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

function doRequests(resp: IResponse|undefined, condition = true): ActionResult {
	if (!condition)
		return ActionResult.Skipped;
	return isFatal(resp?.error) ? ActionResult.FatalError : ActionResult.OK;
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
