import { config } from './Config.js';
import { Logger } from './Logger.js';
import { Utils } from './Utils.js';
import { ErrCode } from './API.js';

const logger = new Logger('Client');

export const UserQueueStatus = {
	None: 'none',
	WaitListed: 'waitlisted', // Deprecated
	Queued: 'queued',
	TempQueued: 'temp-queued',
	Admitted: 'admitted',
	Playing: 'playing'
}

export const UserPlaySessionStatus = {
	ChallengeIssued: 'issued',
	ChallengeReceived: 'received',
	ChallengeAccepted: 'accepted',
	ChallengeRejected: 'rejected',
	WaitingOpponent: 'waiting_opponent',
	Confirmed: 'confirmed',
	Playing: 'playing',
	Completed: 'completed',
	WatchAd: 'watch_ad' // Deprecated
};

export const UserEligibilityStatus = {
	Eligible: 'Eligible',
	AdminSuspended: 'AdminSuspended'
};

export const UserPlaySessionType = {
	Arcade: 'arcade',
	Tower: 'tower',
	Challenge: 'challenge',
	Ad: 'ad'    // Deprecated
}

export class Client {
    constructor(api, metrics, enableDelays = true) {
        this.api = api;
        this.metrics = metrics;
        this.enableDelays = enableDelays;
        this.user = null;
    }

    delay(time, maxTime) {
        Utils.delay(time, maxTime);
    }

    sessionStart(phone) {
        const startupResp = this.api.get('config/startup');
        if (startupResp.error)
            return startupResp;
        const authResp = this.api.auth(phone);
        if (authResp.error)
            return authResp;
        this.user = null;
        let sessionResp = this.api.post('users/session_start', {});
        this.user = sessionResp.data;
        if (sessionResp.error && sessionResp.error.code === ErrCode.UserNotFound) {
            const registerResp = this.api.post('users/register', { inviteCode: '0PENUP' });
            if (registerResp.error)
                return registerResp;
            sessionResp = this.getUser();
        }
        if (sessionResp.data && sessionResp.data.inviteData && sessionResp.data.inviteData.status !== UserQueueStatus.Playing) {
            const activateResp = this.api.post('users/activate', { username: Utils.getUsernameFromPhone(phone) });
            if (activateResp.error)
                return activateResp;
            sessionResp = this.getUser();
        }
        return sessionResp;
    }

    getUser() {
        const resp = this.api.get('users');
        this.user = resp.data;
        return resp;
    }

    setInviter(vusMax) {
        if (this.user && !this.user.inviteData.inviter) {
            logger.info('Set inviter...');
            let attempts = 10;
            while (attempts-- > 0) {
                const n = 1 + Math.round((vusMax - 1) * Math.random());
                const inviter = Utils.getUsername(n);
                if (inviter !== this.user.username) {
                    const resp = this.api.post('users/set_inviter', { inviter });
                    return resp;
                }
            }
        }
        return null;
    }

    getLeaderboard() {
        logger.info('Get leaderboard...');
        const choice = Math.round(100 * Math.random());
        const type = choice <= 33 ? 'highestBalance' : choice <= 66 ? 'mostDonated' : 'surgeScore';
        this.api.get(`users/leaderboard?type=${type}&offset=0&limit=40`);
    }

    cashOut() {
        logger.info('Cash out...');
        if (!this.user) {
            logger.error('No user for cashout!');
            return null;
        }
        const startResp = this.api.post('users/cashout_start', {});
        if (startResp.data && startResp.data.isAllowed) {
            const availableBalance = this.user.account;
            const charityPercent = 10 + Math.round(90 * Math.random());
            const charityAmount = Math.round(availableBalance * (charityPercent / 100));
            const friendPercent = 10;
            const inviterAmount = startResp.hasInviter ? Math.round((availableBalance - charityAmount) * (friendPercent / 100)) : 0;
            const playerAmount = availableBalance - charityAmount - inviterAmount;
            this.delay(30);
            const finishResp = this.api.post('users/cashout_finish', {
                charityPercent: charityPercent,
                desiredCharityAmount: charityAmount,
                desiredInviterAmount: inviterAmount,
                desiredPlayerAmount: playerAmount,
                payee: 'fake@tallyup.com'   // Our fake phone numbers don't validate on the server: this.user.phone
            });
        }
    }

    towerStart() {
        const choice = Math.round(100 * Math.random());
        let resp;
        if (this.user.powerups && this.user.powerups.find(p => p.type === 'TowerJump' && p.qty > 0) && choice > 50) {
            logger.debug('Tower start using power up...');
            resp = this.api.post('users/tower_start', { usePowerUp: 'TowerJump' });
        } else {
            logger.debug('Tower start using fresh penny...');
            resp = this.api.post('users/tower_start', {});
            if (resp.error)
                return resp;
            resp = this.api.post('ads/start', {});
            if (resp.error)
                return resp;
            logger.debug('Watching ad...');
            this.delay(30, 35);
            resp = this.api.post('ads/finish', {});
        }
        return resp;
    }

    pollingDelay() {
        this.delay(1, 1.25);
    }

    requestLevel(levels) {
        const resp = this.api.post('games/request_levels', { game_level: levels, only_bots: false });
        let status;
        const start = Date.now();
        while (status !== UserPlaySessionStatus.Playing) {
            this.pollingDelay();
            if ((Date.now() - start) > 180000) {
                const resp = this.api.post('games/cancel_request_level', {});
                if (!resp.error || resp.error.msg !== 'User is already matched.') {
                    this.pollingDelay();
                    this.getUser();
                    return;
                }
            }
            this.getUser();
            status = this.user && this.user.play && this.user.play.status;
        }
    }

    randomInRange(min, max) {
        return min + (max - min) * Math.random();
    }

    loadGame(gameId) {
//        this.delay(10);
        let resp = this.api.post(`games/${gameId}/event`, { event: { type: 'finishedLoading' } });
        if (resp.error)
            return resp;

        let first = true;
        while (!resp || !resp.data || !resp.data.data) {
            if (!first)
                this.pollingDelay();
            first = false;
            resp = this.api.get(`games/${gameId}`);
            if (resp.error)
                return resp;
        }
        return resp;
    }

    beginRoundTimer(game) {
        const round = game.data.currentRoundData.roundNumber;
        let resp;
        let first = true;
        while (!resp || !resp.data || !resp.data.data) {
            if (!first)
                this.pollingDelay();
            resp = this.api.post(`games/${game.id}/event`, { event: { type: 'beginRoundTimer', data: { round } } });
            if (resp.error)
                return resp;
            first = false;
            resp = this.api.get(`games/${game.id}`);
            if (resp.error)
                return resp;
        }
        return resp;
    }

    makeMove(game) {
        let data;
        if (game.type === 'ShootingGalleryGame') {
            const availableWater = game.data.player.currentRoundData.playerState.water;
            logger.debug(`availableWater=${availableWater}`);
            data = Math.round(this.randomInRange(0, availableWater));
            logger.debug(`value=${data}`);
        } else if (game.type === 'CrystalCaveGame') {
            const availableButtons = [1, 2, 3];
            logger.debug(`availableButtons=${availableButtons}`);
            const buttonIndex = Math.round(this.randomInRange(0, availableButtons.length - 1));
            logger.debug(`button_index=${buttonIndex}`);
            data = availableButtons[buttonIndex];
            logger.debug(`value=${data}`);
        } else if (game.type === 'MagnetGame' || game.type === 'AsteroidGame' || game.type === 'TemplateGame') {
            const buttons = game.data.player.currentRoundData.playerState.buttons;
            const availableButtons = buttons.filter(b => b.isActive).map(b => b.value);
            logger.debug(`availableButtons=${availableButtons}`);
            const buttonIndex = Math.round(this.randomInRange(0, availableButtons.length - 1));
            logger.debug(`buttonIndex=${buttonIndex}`);
            data = availableButtons[buttonIndex];
            logger.debug(`value=${data}`);
        } else {
            throw Error(`Unknown game type ${game.type} in makeMove`);
        }
        const round = game.data.currentRoundData.roundNumber;
        let resp = this.api.post(`games/${game.id}/answer`, { answer: { round, data } });
        return resp;
    }

    playLevel(levels) {
        logger.info('Play levels ' + levels + '...');
        if (!this.user) {
            logger.error('No user!');
            return null;
        }

        if (this.user.account < 1) {
            if (this.user.pennies_remaining === 0) {
                this.metrics.noPennyCount.add(1);
                return null;
            }
            const resp = this.towerStart();
            if (!resp || resp.error) {
                if (resp)
                    logger.error(resp.error.msg);
                this.delay(600);
                return resp;
            }
            this.metrics.pennyAwardedCount.add(1);
        }

        let matchmakingStart = Date.now();
        this.requestLevel(levels);
        if (!this.user.play || this.user.play.status !== UserPlaySessionStatus.Playing || !this.user.play.game) {
            return null;
        }

        const gameId = this.user.play.game;
        const type = this.user.play.game_type;
        const gameLevel = this.user.play.matched_level
        this.metrics.gameCount.add(1, { game: type, level: gameLevel });
        logger.trace('type=' + type);

        let resp = this.loadGame(gameId);

        this.metrics.matchmakingDelay.add(Date.now() - matchmakingStart, { game: type, level: gameLevel });
//        let isBot = resp.data.data.opponent_info.isBot; // TODO: This isn't exposed by our server! Expose it for non-prod stacks?
        let isBot = resp.data.data.opponent_info.username.includes('bot');  // TODO: This assumes bots are called "botN" or similar
        this.metrics.botsPercentage.add(isBot ? 1 : 0, { game: type, level: gameLevel });

        const opponent = resp.data.data.opponent_info.username;
        logger.debug('Opponent: ' + opponent);

        let gameStart = Date.now();
        let n = 1;
        let win_status;
        while (!win_status) {
            let round_number = n;
            let roundStart = Date.now();
            resp = this.beginRoundTimer(resp.data);
            resp = this.makeMove(resp.data);
            let first = true;
            while (round_number === n && !win_status) {
                if (!first)
                    this.pollingDelay();
                first = false;
                resp = this.api.get(`games/${gameId}`);
                if (resp && resp.data && resp.data.data) {
                    round_number = resp.data.data.game_config.round_number;
                    win_status = resp.data.data.game_config.win_status;
                }
            }
            this.metrics.roundDelay.add(Date.now() - roundStart, { game: type, level: gameLevel/*, round: n*/ });
            ++ n;
        }
        resp = this.api.post(`games/${gameId}/event`, { event: { type: 'ackResult' } });
        this.metrics.gameLength.add(Date.now() - gameStart, { game: type, level: gameLevel });
        logger.debug(win_status);
        return resp;
    }

    maxLevel(value) {
        if (value === 0) return value;
        return Math.floor(Math.log10(value) / Math.log10(2) + 1);
    };

    /**
     * Play either a live tower or arcade level game
     */
    playRandomLevel() {
        logger.info('Play random level...');
        if (this.user) {
            const level = Math.max(this.user.account ? Math.round(this.maxLevel(this.user.account) * Math.random()) : 0, 0);
            return this.playLevel([level]);
        }
        return null;
    }

    /**
     * Play a live tower game at highest level possible
     */
    playMaximumLevel() {
        logger.info('Play maximum level...');
        if (this.user) {
            const level = Math.max(this.user.account ? this.maxLevel(this.user.account) : 1, 1);
            return this.playLevel([level]);
        }
        return null;
    }

    returnToTower(fromGame = false) {
        this.delay(60);
        if (fromGame) {
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
        }
        let resp = this.api.get('special_events');
        if (resp.error)
            return resp;
        resp = this.api.get('users/leaderboard?type=surgeScore&offset=0&limit=1');
        if (resp.error)
            return resp;

        return resp;
    }

    returnToMatchups() {
        this.delay(60);
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

        return resp;
    }

    asyncTakeTurn() {
        // Matchups screen
        this.getUser();
        let resp = this.api.get('users/find_challengees');
        if (resp.error)
            return resp;

        if (this.user.sessions) {
            for (const session of this.user.sessions) {
                if (!session.isLive) {
                    let choice = Math.round(100 * Math.random());
                    switch (session.status) {
                        case UserPlaySessionStatus.ChallengeReceived:
                            // PvP screen
                            resp = this.api.get(`users/find?username=${session.opponentUsername}&exact=True`);
                            resp = this.api.get(`users/find_stats?username=${session.opponentUsername}`);
                            this.getUser();
                            if (choice <= 66) {
                                logger.debug(`Accepting match...`);
                                resp = this.api.post('games/accept_match', { sessionId: session.id });
                                resp = this.loadGame(session.game);
                                resp = this.beginRoundTimer(resp.data);
                                resp = this.makeMove(resp.data);
                            } else {
                                logger.debug(`Declining match...`);
                                resp = this.api.post('games/decline_match', { sessionId: session.id });
                            }
                            resp = this.api.get(`users/find?username=${session.opponentUsername}&exact=True`);
                            resp = this.api.get(`users/find_stats?username=${session.opponentUsername}`);
                            this.getUser();
                            break;
                        case UserPlaySessionStatus.ChallengeRejected:
                            logger.debug('Acknowledging declined challenge...');
                            resp = this.api.post('games/acknowledge_match', { sessionId: session.id });
                            break;
                        case UserPlaySessionStatus.Playing:
                            logger.debug('Playing challenge move...');
                            resp = this.loadGame(session.game);
                            resp = this.beginRoundTimer(resp.data);
                            resp = this.makeMove(resp.data);
                            resp = this.returnToMatchups();
                            break;
                        case UserPlaySessionStatus.Completed:
                            logger.debug('Acknowledging completed challenge...');
                            resp = this.api.post('games/acknowledge_match', { sessionId: session.id });
                            resp = this.returnToMatchups();
                            break;
                    }
                }
            }
        }
        return resp;
    }

    asyncIssueChallenge(vusMax) {
        const exclude = [ this.user.username ];
        if (this.user.sessions) {
            if (this.session.length >= 10)
                return null;
            exclude.splice(1, 0, ...this.user.sessions.map(s => s.opponentUsername));
        }
        let opponentUsername;
        let attempts = 10;
        while (attempts-- > 0 && !opponentUsername) {
            const n = 1 + Math.round((vusMax - 1) * Math.random());
            const username = Utils.getUsername(n);
            if (exclude.findIndex(u => u === username) < 0) {
                opponentUsername = username;
                const level = Math.max(this.user.account ? Math.round(this.maxLevel(this.user.account) * Math.random()) : 0, 0);
                logger.debug(`Issuing challenge to ${opponentUsername} at level ${level}...`)
                let resp = this.api.post('games/request_match', {
                    type: 'challenge',
                    level,
                    username: opponentUsername,
                    strictMatching: false,
                    botsOnly: false,
                    gameType: null                
                });
                if (resp && !resp.error) {
                    this.user = resp.data.user;
                    const sessionId = resp.data.sessionId;
                    const session = this.user.sessions.find(s => s.id === sessionId);
                    logger.debug(`Starting challenge with ${opponentUsername} session ${sessionId} game ${session.game}`);
                    resp = this.loadGame(session.game);
                    logger.debug(`Starting challenge resp.error = ${resp.error}`);
                    resp = this.beginRoundTimer(resp.data);
                    let choice = Math.round(100 * Math.random());
                    if (choice <= 10) {
                        // 10% chance to cancel match
                        logger.debug(`Canceling challenge...`)
                        this.api.post('games/cancel_match', { sessionId })
                    } else if (choice <= 75) {
                        // Play 1st move
                        logger.debug(`Making first move...`)
                        resp = this.makeMove(resp.data);
                    } else {
                        // 25% chance to exit before playing 1st move
                        logger.debug(`Quitting without making first move...`)
                    }
                    resp = this.returnToMatchups();
                }
                return resp;
            }
        }
        return null;
    }

    backoff(maxTime) {
        const sleepTime = maxTime * Math.random();
        logger.warn('Backing off VU: ' + __VU + ', ' + sleepTime + ' seconds');
        this.delay(sleepTime, sleepTime);
    }

    killVU(testDuration, startTime) {
        // Kill VU by sleeping past end of test
        const t = (testDuration - (Date.now() - startTime)) / 1000 * 2;
        this.delay(t, t);
    }

    session(phone, startTime, testDuration, startRampDownElapsed, rampDownDuration, vusMax) {
        logger.debug('startTime=' + startTime + ', startRampDownElapsed=' + startRampDownElapsed + ', rampDownDuration=' + rampDownDuration + ', vusMax=' + vusMax);
        this.delay(120);
        const resp = this.sessionStart(phone);
        if (resp.error) {
            logger.error('Error at start of session: ' + JSON.stringify(resp));
            if (resp.error.status === 400 && resp.__type === 'TooManyRequestsException') {
                this.metrics.cognitoThrottleCount.add(1);   // This might abort entire test if it exceeds threshold
                this.backoff(600);
            } else if (resp.error.status >= 500) {
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
        if (!this.user.pennies_remaining) {
            logger.error('No pennies remaining at start of session!');
            this.backoff(600);  // Up to 10 minutes
            return;
        }
        this.api.get('config/towerdata');
        this.getUser();
        this.api.get('config/charitydata');
        this.returnToTower();
        // Convert action percentages
        const taskLevels = {};
        let level = 0;
        taskLevels.exit = level += config.percentages.exit;
        taskLevels.setInviter = level += config.percentages.setInviter;
        taskLevels.leaderboard = level += config.percentages.leaderboard;
        taskLevels.cashOut = level += config.percentages.cashOut;
        taskLevels.liveRandom = level += config.percentages.liveRandom;
        taskLevels.liveMax = level += config.percentages.liveMax;
        taskLevels.asyncTurn = level += config.percentages.asyncTurn;
        taskLevels.asyncChallenge = level += config.percentages.asyncChallenge;
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
            let taskLevel = Math.round(100 * Math.random());
            logger.debug('task=' + taskLevel);
            let fromGame = false;
            if (taskLevel <= taskLevels.exit) {
                // Stop playing for a while
                logger.info('Exiting session...');
                this.delay(120);
                return;
            } else if (taskLevel <= taskLevels.setInviter && this.user && !this.user.inviteData.inviter) {
                // Set inviter
                this.setInviter(vusMax);
            } else if (taskLevel <= taskLevels.leaderboard) {
                // Get the leaderboard
                this.getLeaderboard();
            } else if (taskLevel <= taskLevels && this.user && this.user.account >= 1000) {
                // Attempt to cashout
                this.cashOut();
            } else if (taskLevel <= taskLevels.liveRandom) {
                // Play a random level
                let resp = this.playRandomLevel();
                if (!resp || resp.error) {
                    logger.info('Ending session...');
                    this.delay(this.user.pennies_remaining === 0 ? 600 : 120);
                    return;
                }
                fromGame = true;
            } else if (taskLevel <= taskLevels.liveMax) {
                // Play the highest level allowed
                let resp = this.playMaximumLevel();
                if (!resp || resp.error) {
                    logger.info('Ending session...');
                    this.delay(this.user.pennies_remaining === 0 ? 600 : 120);
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
            this.delay(2, 2.5);
        }
    }
}
