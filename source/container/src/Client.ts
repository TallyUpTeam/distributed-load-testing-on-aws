import { API } from './API';
import { config } from './Config';
import { Logger } from './Logger';
import { Metrics } from './Metrics';
import { IResponse, Utils } from './Utils';
import ErrCode from './tallyup-server/errors/ErrCode';
import { IExposedUser, IExposedUserPlaySession } from './tallyup-server/dtos/types/ExposedUserTypes';
import { UserPlaySessionStatus, UserQueueStatus } from './tallyup-server/models/types/UserTypes';
import { IExposedGame, IExposedGameData } from './tallyup-server/dtos/types/ExposedGameTypes';
import { GameType, IGameButton } from './tallyup-server/models/types/BaseGameTypes';

const logger = new Logger('Client');

const delay = Utils.delay;
const delayRange = Utils.delayRange;
const randomInRange = Utils.randomInRange;

type IXUser = IExposedUser & {
	liveSession?: IExposedUserPlaySession;
} | undefined;

type IXGame = IExposedGame<IExposedGameData<any, any, any, any>>;	// eslint-disable-line @typescript-eslint/no-explicit-any

export class Client {
	private api: API;
	private metrics: Metrics;
	private user: IXUser;
	private playAsync: boolean;	// Will make async challenges and play async games
	private opponentUsername: string|undefined;	// Opponent faced in last game played

	constructor(api: API, metrics: Metrics) {
		this.api = api;
		this.metrics = metrics;
		this.user = undefined;
		this.opponentUsername = undefined;
		this.playAsync = config.playAsync === true;
	}

	private sessionStart(phone: string): IResponse {
		const startupResp = this.api.post('startup', { foregrounded: false, installed: false });
		if (startupResp.error)
			return startupResp;
		const authResp = this.api.auth(phone);
		if (authResp.error)
			return authResp;
		this.user = undefined;
		let sessionResp = this.api.post('users/session_start', {});
		if (sessionResp.error && sessionResp.error.code === ErrCode.UserNotFound) {
			const registerResp = this.api.post('users/register', { inviteCode: '0PENUP' });
			if (registerResp.error)
				return registerResp;
			sessionResp = registerResp;
		}
		if ((sessionResp.data as IExposedUser)?.inviteData?.status !== UserQueueStatus.Playing) {
			const activateResp = this.api.post('users/activate', { username: Utils.getUsernameFromPhone(phone) });
			if (activateResp.error)
				return activateResp;
			sessionResp = activateResp;
		}
		this.user = sessionResp.data as IExposedUser;
		return sessionResp;
	}

	private getUser(projection = 'standard'): IResponse {
		const resp = this.api.get(`users?projection=${projection}`);
		this.setUser(resp);
		return resp;
	}

	private setUser(resp: IResponse): void {
		this.user = resp.data as IExposedUser;
		if (this.user)
			this.user.liveSession = this.getLiveSession(this.user);
	}

	private getLiveSession(user: IXUser): IExposedUserPlaySession|undefined {
		return user?.sessions?.find(s => s.isLive);
	}

	private setInviter(vusMax: number): IResponse {
		if (this.user && !this.user.inviteData.invited) {
			logger.info('Set inviter...');
			let attempts = 10;
			while (attempts-- > 0) {
				const n = 1 + Math.round((vusMax - 1) * Math.random());
				const inviter = Utils.getUsername(n);
				if (inviter !== this.user.username) {
					const resp = this.api.post('users/set_inviter', { inviter });
					if (!resp.error)
						this.setUser(resp);
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

	private getLeaderboard(): void {
		logger.info('Get leaderboard...');
		const choice = Math.round(100 * Math.random());
		const type = choice <= 33 ? 'highestBalance' : choice <= 66 ? 'mostDonated' : 'surgeScore';
		this.api.get(`users/leaderboard?type=${type}&offset=0&limit=40`);
	}

	private cashOut(): void {
		logger.info('Cash out...');
		if (!this.user) {
			logger.error('No user for cashout!');
			return;
		}
		const startResp = this.api.post('users/cashout_start', {});
		if ((startResp?.data as Record<string, unknown>)?.isAllowed) {
			const availableBalance = this.user.account;
			const charityPercent = 10 + Math.round(90 * Math.random());
			const charityAmount = Math.round(availableBalance * (charityPercent / 100));
			const friendPercent = 10;
			const inviterAmount = startResp.hasInviter ? Math.round((availableBalance - charityAmount) * (friendPercent / 100)) : 0;
			const playerAmount = availableBalance - charityAmount - inviterAmount;
			delayRange(1, 30);
			const finishResp = this.api.post('users/cashout_finish', {
				charityPercent: charityPercent,
				desiredCharityAmount: charityAmount,
				desiredInviterAmount: inviterAmount,
				desiredPlayerAmount: playerAmount,
				payee: `fake_${this.user?.phone.slice(2)}@tallyup.com`
			});
			if (!finishResp.error)
				this.setUser(finishResp);
		}
	}

	private towerStart(): IResponse {
		const choice = Math.round(100 * Math.random());
		let resp = this.api.post('ads/start', {});
		if (resp.error)
			return resp;
		logger.debug('Watching ad...');
		delayRange(30, 35);
		resp = this.api.post('ads/finish', {});
		if (resp.error)
			return resp;
		if (this.user?.powerUps?.find(p => p.type === 'TowerJump' && p.qty > 0) && choice > 50) {
			logger.debug('Tower start using MegaSpin...');
			resp = this.api.post('users/award_tokens', { usePowerUp: 'TowerJump' });
		} else if (this.user && this.user.spinsRemaining > 0) {
			logger.debug('Tower start using basic spin...');
			resp = this.api.post('users/award_tokens', { usePowerUp: null });
		}
		if (!resp.error)
			this.setUser(resp);
		return resp;
	}

	private pollingDelay(): void {
		delayRange(2, 2.25);
	}

	private requestLevel(levels: number[]): void {
		let resp = this.api.post('games/request_levels', { game_level: levels, only_bots: false });	// eslint-disable-line @typescript-eslint/naming-convention
		let status;
		const start = Date.now();
		while (status !== UserPlaySessionStatus.Confirmed) {
			if ((Date.now() - start) > 180000) {	// 180 seconds without a match
				resp = this.api.post('games/cancel_request_level', {});
				if (!resp.error || resp.error.msg !== 'User is already matched.') {
					this.pollingDelay();
					this.getUser();
					return;
				}
			}
			this.pollingDelay();
			this.getUser();
			status = this.user?.liveSession?.status;
		}
		this.opponentUsername = this.user?.liveSession?.opponentUsername;
		this.api.get(`users/find?username=${this.opponentUsername}&allowBots=True&projection=brief&exact=True`);
		delayRange(12, 13);	// Spinner animation
		while (status !== UserPlaySessionStatus.Playing) {
			this.pollingDelay();
			this.getUser();
			status = this.user && this.user.liveSession && this.user.liveSession.status;
		}
	}

	private loadGame(gameId: string): IResponse {
		delayRange(2, 3);
		let resp = this.api.post(`games/${gameId}/event`, { event: { type: 'finishedLoading' } });
		if (resp.error)
			return resp;

		let first = true;
		while (!resp.data || !(resp.data as IXGame).data) {
			if (!first)
				this.pollingDelay();
			first = false;
			resp = this.api.get(`games/${gameId}`);
			if (resp.error)
				return resp;
		}
		return resp;
	}

	private beginRoundTimer(game: IXGame): IResponse {
		const round = game.data.currentRoundData.roundNumber;
		let resp = {} as IResponse;
		let first = true;
		while (!(resp?.data as IXGame)?.data) {
			if (!first)
				this.pollingDelay();
			resp = this.api.post(`games/${game.id}/event`, { event: { type: 'beginRoundTimer', data: { round } } });
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
			logger.debug(`availableWater=${availableWater}`);
			data = Math.round(randomInRange(0, availableWater));
			logger.debug(`value=${data}`);
		} else if (game.type === GameType.CrystalCaverns) {
			const availableButtons = [1, 2, 3];
			logger.debug(`availableButtons=${availableButtons}`);
			const buttonIndex = Math.round(randomInRange(0, availableButtons.length - 1));
			logger.debug(`button_index=${buttonIndex}`);
			data = availableButtons[buttonIndex];
			logger.debug(`value=${data}`);
		} else if (game.type === GameType.MagnetMadness || game.type === GameType.Blasteroids) {
			const buttons = game.data.player.currentRoundData.playerState.buttons as IGameButton[];
			const availableButtons = buttons.filter(b => b.isActive).map(b => b.value);
			logger.debug(`availableButtons=${availableButtons}`);
			const buttonIndex = Math.round(randomInRange(0, availableButtons.length - 1));
			logger.debug(`buttonIndex=${buttonIndex}`);
			data = availableButtons[buttonIndex];
			logger.debug(`value=${data}`);
		} else {
			throw Error(`Unknown game type ${game.type} in makeMove`);
		}
		const round = game.data.currentRoundData.roundNumber;
		const resp = this.api.post(`games/${game.id}/answer`, { answer: { round, data } });
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
		this.requestLevel(levels);
		if (!this.user.liveSession || this.user.liveSession.status !== UserPlaySessionStatus.Playing || !this.user.liveSession.game) {
			resp.error = { msg: 'No live game found!' };
			return resp;
		}

		const gameId = this.user.liveSession.game;
		const type = this.user.liveSession.gameType;
		const gameLevel = this.user.liveSession.matchedLevel;
		this.metrics.liveGameCount.add(1, { game: type, level: gameLevel.toString() });
		logger.trace('type=' + type);

		resp = this.loadGame(gameId);
		if (resp.error)
			return resp;
		let game = resp.data as IXGame;
		delayRange(4, 5);

		this.metrics.matchmakingDelay.add(Date.now() - matchmakingStart, { game: type, level: gameLevel.toString() });
		const isBot = game.isBot;
		this.metrics.botsPercentage.add(isBot ? 1 : 0, { game: type, level: gameLevel.toString() });

		const gameStart = Date.now();
		let n = 1;
		let winStatus;
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
				this.pollingDelay();
				resp = this.api.get(`games/${gameId}`);
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
		resp = this.api.post(`games/${gameId}/event`, { event: { type: 'ackResult' } });
		this.metrics.liveGameLength.add(Date.now() - gameStart, { game: type, level: gameLevel.toString() });
		logger.debug(winStatus);
		return resp;
	}

	private maxLevel(value: number): number {
		if (value === 0) return value;
		return Math.floor(Math.log10(value) / Math.log10(2) + 1);
	}

	private levelValue(level: number): number {
		if (level == null || level < 0)
			return undefined as unknown as number;	// Guaranteed to fail comparisons
		if (level === 0)
			return 0;
		return Math.pow(2, level - 1);
	}

	/**
	 * Play either a live tower or arcade level game
	 */
	private playRandomLevel(): IResponse {
		logger.info('Play random level...');
		if (this.user) {
			const level = Math.max(this.user.account ? Math.round(this.maxLevel(this.user.account) * Math.random()) : 0, 0);
			return this.playLevel([level]);
		}
		return { error: { msg: 'No user!' }} ;
	}

	/**
	 * Play a live tower game at highest level possible
	 */
	private playMaximumLevel(): IResponse {
		logger.info('Play maximum level...');
		if (this.user) {
			const level = Math.max(this.user.account ? this.maxLevel(this.user.account) : 1, 1);
			return this.playLevel([level]);
		}
		return { error: { msg: 'No user!' } };
	}

	private returnToTower(fromGame = false): IResponse {
		delayRange(1, 60);
		if (fromGame) {
			let resp = this.api.get('config/towerdata');
			if (resp.error)
				return resp;
			resp = this.api.get('config/appdata');
			if (resp.error)
				return resp;
			resp = this.api.get('config/charitydata');
			if (resp.error)
				return resp;
			resp = this.getUser();
			if (resp.error)
				return resp;
			resp = this.api.get(`users/find?username=${this.opponentUsername}&allowBots=True&projection=brief&exact=True`);
			if (resp.error)
				return resp;
		}
		const resp = this.api.get('special_events');
		if (resp.error)
			return resp;
		if (this.user && this.user.account < 1) {
			if (this.user.spinsRemaining === 0) {
				this.metrics.noPennyCount.add(1);
				return { error: { msg: 'No spinsRemaining!'}};
			}
			const resp = this.towerStart();
			if (!resp || resp.error) {
				if (resp?.error?.msg)
					logger.error(resp.error.msg);
				delay(300); 	// 5 min cool down before retrying
				return resp;
			}
			this.metrics.pennyAwardedCount.add(1);
		}
		return resp;
	}

	private goToMatchups(): IResponse {
		// Matchups screen
		let resp = this.api.get('users/find_challengees');
		if (resp.error)
			return resp;
		resp = this.getUser();
		if (resp.error)
			return resp;

		return resp;
	}

	private returnToMatchups(): IResponse {
		delayRange(0, 30);
		let resp = this.api.get('config/startup');
		if (resp.error)
			return resp;
		resp = this.api.get('config/towerdata');
		if (resp.error)
			return resp;
		resp = this.getUser();
		if (resp.error)
			return resp;
		resp = this.api.get('config/charitydata');
		if (resp.error)
			return resp;
		resp = this.api.get('special_events');
		if (resp.error)
			return resp;
		resp = this.getUser();
		if (resp.error)
			return resp;
		resp = this.api.get('users/find_challengees');
		if (resp.error)
			return resp;
		resp = this.api.get('users/leaderboard?type=surgeScore&offset=0&limit=1');
		if (resp.error)
			return resp;

		return resp;
	}

	private goToPvP(opponentUsername: string): IResponse {
		let resp = this.getUser();
		if (resp.error)
			return resp;
		resp = this.api.get(`users/find_stats?username=${opponentUsername}`);
		if (resp.error)
			return resp;
		resp = this.api.get(`users/find?username=${opponentUsername}&exact=True`);
		if (resp.error)
			return resp;

		return resp;
	}

	private asyncTakeTurn(): IResponse {
		let resp = this.goToMatchups();
		if (resp.error)
			return resp;

		if (this.user?.sessions) {
			for (const session of this.user.sessions) {
				if (!session.isLive && session.requiresAction) {
					let choice = Math.round(100 * Math.random());
					switch (session.status) {
					case UserPlaySessionStatus.ChallengeReceived:
						logger.debug('Calling goToPvP 1');
						this.goToPvP(session.opponentUsername);
						if (choice <= 75 && this.user.account >= this.levelValue(session.requestedLevel)) {
							logger.debug(`Accepting match...`);
							resp = this.api.post('games/accept_match', { sessionId: session.id });
							if (!resp.error) {  // Might have been canceled before we tried to accept
								resp = this.loadGame(session.game);
								if (!resp.error)
									resp = this.beginRoundTimer(resp.data as IXGame);
								if (!resp.error)
									resp = this.makeMove(resp.data as IXGame);
								if (!resp.error)
									this.metrics.asyncGameAccepts.add(1, { game: (resp.data as IXGame).type, level: session.requestedLevel.toString() });
							}
						} else {
							logger.debug(`Declining match...`);
							resp = this.api.post('games/decline_match', { sessionId: session.id });
							if (!resp.error) {
								logger.debug('Calling goToPvP 2');
								resp = this.goToPvP(session.opponentUsername);
							}
							if (!resp.error)
								this.metrics.asyncGameDeclines.add(1, { game: 'unknown', level: session.requestedLevel.toString() });
						}
						resp = this.returnToMatchups();
						break;
					case UserPlaySessionStatus.ChallengeRejected:
						logger.debug('Acknowledging declined challenge...');
						resp = this.api.post('games/acknowledge_match', { sessionId: session.id });
						resp = this.goToMatchups();
						break;
					case UserPlaySessionStatus.Playing:
						{
							logger.debug('Playing challenge move...');
							resp = this.loadGame(session.game);
							if (!resp.error)
								resp = this.beginRoundTimer(resp.data as IXGame);
							if (!resp.error)
								resp = this.makeMove(resp.data as IXGame);
							if (!resp.error)
								this.metrics.asyncGameMoves.add(1, { game: (resp.data as IXGame).type, level: session.requestedLevel.toString() });
						}
						resp = this.returnToMatchups();
						break;
					case UserPlaySessionStatus.Completed:
						{
							logger.debug('Acknowledging completed challenge...');
							resp = this.api.post('games/acknowledge_match', { sessionId: session.id });
							if (!resp.error)
								this.metrics.asyncGameCompletes.add(1, { game: 'unknown', level: session.requestedLevel.toString() });
						}
						resp = this.returnToMatchups();
						break;
					}
					delayRange(1, 10);
					choice = Math.round(100 * Math.random());
					if (choice < 50)    // 50% chance of quitting out of matchups screen back to tower
						return resp;
				}
			}
		}
		return resp;
	}

	private asyncIssueChallenge(vusMax: number): IResponse {
		let resp: IResponse;
		if (!this.user) {
			this.getUser();
			if (!this.user) {
				resp = {}; resp.error = { msg: 'No current user!' };
				logger.error(resp.error.msg as string);
				return resp;
			}
		}
		const exclude = [this.user?.username];
		if (this.user.sessions) {
			if (this.user.sessions.length >= 10)
				return {};
			exclude.splice(1, 0, ...this.user.sessions.map(s => s.opponentUsername));
		}
		let opponentUsername;
		let attempts = 10;
		while (attempts-- > 0 && !opponentUsername) {
			const n = 1 + Math.round((vusMax - 1) * Math.random());
			if ((n - 1) % vusMax === 0)
				continue;
			const username = Utils.getUsername(n);
			if (exclude.findIndex(u => u === username) < 0) {
				opponentUsername = username;
				const level = Math.max(this.user.account ? Math.round(this.maxLevel(this.user.account) * Math.random()) : 0, 0);
				logger.debug(`Issuing challenge to ${opponentUsername} at level ${level}...`);
				let resp = this.api.post('games/request_match', {
					type: 'challenge',
					level,
					username: opponentUsername,
					strictMatching: false,
					botsOnly: false,
					gameType: null
				});
				if (resp && !resp.error) {
					const respData = resp.data as { user: IXUser, sessionId: string };
					this.user = respData.user;
					const sessionId = respData.sessionId;
					const session = this.user?.sessions?.find(s => s.id === sessionId);
					if (!session) {
						resp = { error: { msg: `Session ${sessionId} not found after requesting challenge!` } };
						logger.error(resp.error?.msg as string);
						return resp;
					}
					logger.debug(`Starting challenge with ${opponentUsername} session ${sessionId} game ${session.game}`);
					resp = this.loadGame(session.game);
					if (resp.error) {
						logger.debug(`Starting challenge resp.error = ${resp.error}`);
						return resp;
					}
					const game = resp.data as IXGame;
					const gameType = game.type;
					resp = this.beginRoundTimer(game);
					const choice = Math.round(100 * Math.random());
					if (choice <= 10) {
						// 10% chance to cancel match
						logger.debug(`Canceling challenge...`);
						this.api.post('games/cancel_match', { sessionId });
					} else if (choice <= 75) {
						// Play 1st move
						logger.debug(`Making first move...`);
						resp = this.makeMove(game);
					} else {
						// 25% chance to exit before playing 1st move
						logger.debug(`Quitting without making first move...`);
					}
					this.metrics.asyncGameStarts.add(1, { game: gameType, level: session.requestedLevel .toString() });
					resp = this.returnToMatchups();
				}
				return resp;
			}
		}
		return { error: { msg: 'Couldn\'t make match' } };
	}

	private backoff(maxTime: number): void {
		const sleepTime = maxTime * Math.random();
		logger.warn('Backing off VU: ' + __VU + ', ' + sleepTime + ' seconds');
		delayRange(sleepTime, sleepTime);
	}

	private killVU(testDuration: number, startTime: number): void {
		// Kill VU by sleeping past end of test
		const t = (testDuration - (Date.now() - startTime)) / 1000 * 2;
		delayRange(t, t);
	}

	public session(phone: string, startTime: number, testDuration: number, startRampDownElapsed: number, rampDownDuration: number, vusMax: number): void {
		logger.debug('startTime=' + startTime + ', startRampDownElapsed=' + startRampDownElapsed + ', rampDownDuration=' + rampDownDuration + ', vusMax=' + vusMax);
		const resp = this.sessionStart(phone);
		if (resp.error) {
			logger.error('Error at start of session: ' + JSON.stringify(resp));
			if (resp.error.status === 400 && resp.__type === 'TooManyRequestsException') {
				this.metrics.cognitoThrottleCount.add(1);   // This might abort entire test if it exceeds threshold
				this.backoff(600);
			} else if (resp.error.status as number >= 500) {
				this.backoff(60);
			} else {
				// Non-retryable error - kill VU
				logger.warn('Stopping VU: ' + __VU);
				this.killVU(testDuration, startTime);
			}
			return;
		}
		if (!this.user) {
			logger.error('No user at start of session!');
			this.backoff(60);
			return;
		}
		if (!this.user.spinsRemaining) {
			logger.error('No spins remaining at start of session!');
			this.backoff(600);  // Up to 10 minutes
			return;
		}
		this.api.get('config/towerdata');
		this.api.get('config/appData');
		this.getUser();
		this.api.get('config/charitydata');
		this.returnToTower();
		// Convert action percentages
		const taskLevels = {
			exit: 0,
			setInviter: 0,
			leaderboard: 0,
			cashOut: 0,
			liveRandom: 0,
			liveMax: 0,
			asyncTurn: 0,
			asyncChallenge: 0,
		};
		let level = 0;
		const adjustment = this.playAsync ? 1 : 100 / (100 - config.percentages.asyncTurn - config.percentages.asyncChallenge);
		logger.info(`adjustment=${adjustment}`);
		taskLevels.exit = level += config.percentages.exit * adjustment;
		taskLevels.setInviter = level += config.percentages.setInviter * adjustment;
		taskLevels.leaderboard = level += config.percentages.leaderboard * adjustment;
		taskLevels.cashOut = level += config.percentages.cashOut * adjustment;
		taskLevels.liveRandom = level += config.percentages.liveRandom * adjustment;
		taskLevels.liveMax = level += config.percentages.liveMax * adjustment;
		if (this.playAsync) {
			taskLevels.asyncTurn = level += config.percentages.asyncTurn;
			taskLevels.asyncChallenge = level += config.percentages.asyncChallenge;
		}
		if (level !== 100) {
			logger.error(`Percentages don't sum to 100: ${level}`);
			this.killVU(testDuration, startTime);
		}
		while (true) {
			const now = Date.now();
			const elapsed = now - startTime;
			logger.trace('elapsedTime=' + elapsed);
			// If we're past the start of ramp-down, see if this VU should stop playing now
			if (elapsed > startRampDownElapsed) {
				const rampDownElapsed = elapsed - startRampDownElapsed;
				let vusFrac = 1 - rampDownElapsed / rampDownDuration;
				if (vusFrac < 0) vusFrac = 0;
				logger.trace('vusFrac=' + vusFrac + ', rampDownElapsed=' + rampDownElapsed);
				if (__VU > vusFrac * vusMax) {
					logger.info('Ramping down VU: ' + __VU + ', vusFrac=' + vusFrac + ', elapsed=' + elapsed);
					this.killVU(testDuration, startTime);
					return;
				}
			}
			// Take some random action to simulate a user pressing buttons
			const taskLevel = Math.round(100 * Math.random());
			logger.debug('task=' + taskLevel);
			let fromGame = false;
			if (taskLevel <= taskLevels.exit) {
				// Stop playing for a while
				logger.info('Exiting session...');
				delay(120);
				return;
			} else if (taskLevel <= taskLevels.setInviter && this.user && !this.user.inviteData.invited) {
				// Set inviter
				this.setInviter(vusMax);
			} else if (taskLevel <= taskLevels.leaderboard) {
				// Get the leaderboard
				this.getLeaderboard();
			} else if (taskLevel <= taskLevels.cashOut && this.user && this.user.account >= 1000) {
				// Attempt to cashout
				this.cashOut();
			} else if (taskLevel <= taskLevels.liveRandom) {
				// Play a random level
				const resp = this.playRandomLevel();
				if (!resp || resp.error) {
					logger.info('Ending session...');
					delay(this.user.spinsRemaining === 0 ? 600 : 120);
					return;
				}
				fromGame = true;
			} else if (taskLevel <= taskLevels.liveMax) {
				// Play the highest level allowed
				const resp = this.playMaximumLevel();
				if (!resp || resp.error) {
					logger.info('Ending session...');
					delay(this.user.spinsRemaining === 0 ? 600 : 120);
					return;
				}
				fromGame = true;
			} else if (taskLevel <= taskLevels.asyncTurn) {
				// Take a turn, if available: make a move, accept/decline/cancel/ack a challenge
				this.asyncTakeTurn();
			} else if (taskLevel <= taskLevels.asyncChallenge) {
				// Challenge another player
				this.asyncIssueChallenge(vusMax);
			}
			this.returnToTower(fromGame);
			delayRange(2, 2.5);
		}
	}
}
