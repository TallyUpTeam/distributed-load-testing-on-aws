import http from 'k6/http';
import { Logger } from './Logger.js';
import { Utils } from './Utils.js';

const logger = new Logger('API');

export const ErrCode = {
	None:                           0,
	PhoneNumberInvalid:             1,  // Phone number not found in Cognito account (shouldn't be possible)
	UsernameInvalid:                2,  // Given username undefined, null, or otherwise invalid (too long or short or invalid characters)
	UsernameInUse:                  3,  // Username already taken, during activation
	UpdateFailure:                  4,  // Internal error - couldn't update a user in DB after multiple attempts
	UserNotFound:                   5,  // A user corresponding to the authenticated Cognito account doesn't exist (not registered)
	PercentageInvalid:              6,  // Charity percentage too low or high, during cashout
	AccountInsufficient:            7,  // Not enough money, during cashout
	CognitoError:                   8,  // Cannot find Cognito account for given access token
	PhoneNumberUnconfirmed:         9,  // Cognito account has unconfirmed phone number (shouldn't be possible)
	AlreadyRegistered:              10, // This user account already exists, during registration
	InviteCodeInvalid:              11, // From a deprecated feature but leave here to maintain numeric values
	AlreadyPlaying:                 12, // This user account already active, during activation
	NotAdmitted:                    13, // Queued user not admitted yet, during activation
	NotPlaying:                     14, // User hasn't activated yet
	AdmissionExpired:               15, // Admission from queue has expired, during activation
	NotQueued:                      16, // Attempt to get queue rank of user not in queue
	AuthError:                      17, // Access token was undefined, missing, or invalid (could not authenticate with it)
	CashOutInvalidState:            18, // Attempt to cash out during a live game
	IncompatibleClientVersion:      19, // Client version is too old for server
	IncompatibleServerVersion:      20, // Server version is too old for client
	PayeeInvalid:                   21, // Payee information undefined, null, or not a valid phone number or email, during cashout
	InternalError:                  22, // Internal server error (generic code for HTTP '500 Internal Server Error')
	InvalidQueryParams:             23, // Missing query (or body) param - only used for missing deviceToken in push note registration
	AmountInvalid:                  24, // Charity, player, or inviter amount was undefined or null, during cashout
	GameNotPlayable:                25, // Game initialized but not in a playable state yet (unused)
	AdError:                        26, // General error during watching an ad or awarding a fresh penny (deprecated)
	UserIneligible:                 27, // User has been banned
	TransactionTimeout:             28, // Internal error - multi-update database transaction didn't complete in time
	DocumentTimeout:                29, // Internal error - single document database update didn't complete in time
	CommitTransactionRetriesExceeded: 30,   // Internal error - multi-update database transaction couldn't be committed due to conflicting updates
	TransactionRetriesExceeded:     31, // Internal error - multi-update database transaction couldn't be completed due to conflicting updates
	DocumentRetriesExceeded:        32, // Internal error - single document database update couldn't be completed due to conflicting updates
	OCCVersionMismatch:             33, // An internal error used by the system
	NoDeviceId:                     34, // Device id was undefined or null
	MultiDevicePlay:                35, // User account is also playing on another device
	InvalidLeaderboardType:         36, // Requested type undefined, null, or un-recognized
	InvalidLevelRequest:            37, // General error when requesting a live game
	InvalidPowerUp:                 38, // Given powerup undefined, null, or unknown type, during tower start
	NoPowerUpAvailable:             39, // User has no powerups for jump, during tower start
	NoPenniesAvailable:             40, // User has no free pennies available to claim, during tower start
	InvalidInviter:                 41, // Inviter user account not found, during set-inviter
	InvalidQuantity:                42, // Only used by admin UI
	LevelTooHigh:                   43, // User at too high level to use tower jump, or already has a balance when claiming penny
	AlreadyInvited:                 44, // User already called set-inviter
	GlobalPennyCapExceeded:         45, // Cannot claim a new penny because too many already given out today
	SessionNotFound:                46, // No session found for given sessionId, or no user session corresponds to given gameId
	OpponentIneligible:             47, // Opponent has been banned, when issuing a challenge
	OpponentNotPlaying:             48, // Opponent not activated, when issuing a challenge
	DuplicateChallenge:             49, // User already has a challenge with given opponent, when issuing a challenge
	InvalidSession:                 50, // User's or opponent's session is in wrong state, when accepting/declining/cancelling/acknowledging a challenge
	OpponentNotFound:               51, // Opponent username not found, when issuing/accepting/declining/cancelling/acknowledging a challenge
	NoSessionId:                    52, // Given sessionId was undefined or null
	NoGameForSession:               53, // Couldn't find corresponding game for session when acknowledging a result
	OpponentUsernameInvalid:        54, // Given opponent username was undefined, null, or invalid
	NotAtLevel:                     55, // User doesn't have enough balance for level when issuing or accepting challenge
	AmountMismatch:                 56, // The client's player, charity, or inviter amounts are incorrect, during cashout end (maybe balance changed?)
	GameUnavailable:                57, // User hasn't unlocked requested game when issuing or accepting challenge
	OpponentGameUnavailable:        58, // Opponent hasn't unlocked requested game (or opponent doesn't have any of same games unlocked), when issuing challenge
    ServerMaintenanceDowntime:      59, // Server maintenance in progress
    GameNotFound:                   60, // Game not found for given gameId
    SessionsExceeded:               61  // Attempt to create too many sessions when issuing a challenge
    // NOTE: Keep this in sync with tallyup-server/src/shared/errors/ErrCode.ts!
};

export class API {
    constructor(idp, metrics, urlBase) {
        this.idp = idp;
        this.metrics = metrics;
        this.urlBase = urlBase;
        this.phone = '';
        this.accessToken = '';
        this.accessTokenExpiry = 0;
        this.refreshToken = '';
    }

    auth(phone) {   
        this.phone = phone;
        const signUpResp = this.idp.signUp(phone);
        if (signUpResp.error && signUpResp.error.status !== 400 && signUpResp.__type !== 'UsernameExistsException')
            return signUpResp;
        const initiateAuthResp = this.idp.initiateAuth(phone);
        if (initiateAuthResp.error)
            return initiateAuthResp;
        const respondResp = this.idp.respondToAuthChallenge(phone, initiateAuthResp.Session);
        if (respondResp && respondResp.AuthenticationResult) {
            this.accessToken = respondResp.AuthenticationResult.AccessToken;
            this.accessTokenExpiry = Date.now() + (respondResp.AuthenticationResult.ExpiresIn - 60) * 1000; // Start refreshing 1 minute before expiry
            this.refreshToken = respondResp.AuthenticationResult.RefreshToken;
        } else {
            this.accessToken = '';
            this.accessTokenExpiry = 0;
            this.refreshToken = null;
        }
        return respondResp;
    }

    refreshAuth() {
        if (!this.refreshToken || Date.now() < this.accessTokenExpiry)
            return;
        logger.warn('Refreshing accessToken: ' + this.phone);
        const refreshResp = this.idp.refreshAuth(this.phone, this.refreshToken);
        if (refreshResp && refreshResp.AuthenticationResult) {
            this.accessToken = refreshResp.AuthenticationResult.AccessToken;
            this.accessTokenExpiry = Date.now() + (refreshResp.AuthenticationResult.ExpiresIn - 60) * 1000; // Start refreshing 1 minute before expiry
        } else {
            this.accessToken = null;
            this.accessTokenExpiry = 0;
        }
        return refreshResp;
    }

    get(urlPath) {
        const refreshResp = this.refreshAuth();
        if (refreshResp && refreshResp.error)
            return refreshResp;
        let tries = 3;
        let json;
        while (tries) {
            const resp = http.get(
                this.urlBase + urlPath,
                {
                    headers: {
                        'Authorization': 'Bearer ' + this.accessToken,
                        'X-TU-device-Id': '00000000-0000-0000-0000-000000000000'
                    }
                }
            );
            logger.trace('GET ' + urlPath + ' ' + resp.status + ': ' + resp.body);
                json = Utils.parseResponseBody(resp);
            if (resp.status < 200 || (resp.status >= 300 && resp.status < 502))
                // It's expected for session_start to return UserNotFound error to denote user isn't registered
                if (urlPath !== 'users/session_start' || !json || !json.error || json.error.code != ErrCode.UserNotFound)
                    this.metrics.apiErrorCount.add(1);
            else if (resp.error_code == 1211)
                this.metrics.timeoutCount.add(1);
            else if (resp.error_code)
                this.metrics.networkErrorCount.add(1);
            if (!resp.status || resp.status < 500)
                break;
            -- tries;
            Utils.delay(1, 5);
            if (tries > 0)
                logger.warn('GET ' + urlPath + ' retrying after ' + JSON.stringify(json));
        }
        return json;
    }

    post(urlPath, body) {
        const refreshResp = this.refreshAuth();
        if (refreshResp && refreshResp.error)
            return refreshResp;
        let tries = 3;
        let json;
        while (tries) {
            const resp = http.post(
                this.urlBase + urlPath,
                JSON.stringify(body),
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + this.accessToken,
                        'X-TU-device-Id': '00000000-0000-0000-0000-000000000000'
                    }
                }
            );
            logger.trace('POST ' + urlPath + ' ' + resp.status + ': ' + resp.body);
            json = Utils.parseResponseBody(resp);
            if (resp.status < 200 || (resp.status >= 300 && resp.status < 502))
                // It's expected for session_start to return UserNotFound error to denote user isn't registered
                if (urlPath !== 'users/session_start' || !json || !json.error || json.error.code != ErrCode.UserNotFound)
                    this.metrics.apiErrorCount.add(1);
            else if (resp.error_code == 1211)
                this.metrics.timeoutCount.add(1);
            else if (resp.error_code)
                this.metrics.networkErrorCount.add(1);
            if (!resp.status || resp.status < 500)
                break;
            -- tries;
            Utils.delay(1, 5);
            if (tries > 0)
                logger.warn('POST ' + urlPath + ' retrying after ' + JSON.stringify(json));
        }
        return json;
    }
}
