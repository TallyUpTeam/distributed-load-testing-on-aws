import http from 'k6/http';
import { IDP } from './Cognito';
import { Logger } from './Logger';
import { Metrics } from './Metrics';
import { IResponse, Utils } from './Utils';
import ErrCode from './tallyup-server/errors/ErrCode';

const logger = new Logger('API');

export class API {
	private idp: IDP;
	private metrics: Metrics;
	private urlBase: string;
	private phone: string;
	private accessToken: string;
	private accessTokenExpiry: number;
	private refreshToken: string;

	public constructor(idp: IDP, metrics: Metrics, urlBase: string) {
		this.idp = idp;
		this.metrics = metrics;
		this.urlBase = urlBase;
		this.phone = '';
		this.accessToken = '';
		this.accessTokenExpiry = 0;
		this.refreshToken = '';
	}

	public auth(phone: string): IResponse {
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
			this.refreshToken = '';
		}
		return respondResp;
	}

	public refreshAuth(): IResponse|undefined {
		if (!this.refreshToken || Date.now() < this.accessTokenExpiry)
			return undefined;
		logger.warn('Refreshing accessToken: ' + this.phone);
		const refreshResp = this.idp.refreshAuth(this.phone, this.refreshToken);
		if (refreshResp && refreshResp.AuthenticationResult) {
			this.accessToken = refreshResp.AuthenticationResult.AccessToken;
			this.accessTokenExpiry = Date.now() + (refreshResp.AuthenticationResult.ExpiresIn - 60) * 1000; // Start refreshing 1 minute before expiry
		} else {
			this.accessToken = '';
			this.accessTokenExpiry = 0;
		}
		return refreshResp;
	}

	public get(urlPath: string): IResponse {
		const refreshResp = this.refreshAuth();
		if (refreshResp && refreshResp.error)
			return refreshResp;
		let tries = 3;
		let json = {} as IResponse;	// Initialize to an empty response to silence a warning - will definitely be re-assigned
		while (tries) {
			const resp = http.get(
				this.urlBase + urlPath,
				{
					/* eslint-disable @typescript-eslint/naming-convention */
					headers: {
						'Authorization': 'Bearer ' + this.accessToken,
						'X-TU-device-Id': '00000000-0000-0000-0000-000000000000'
					}
					/* eslint-enable @typescript-eslint/naming-convention */
				}
			);
			logger.trace('GET ' + urlPath + ' ' + resp.status + ': ' + resp.body);
			json = Utils.parseResponseBody(resp);
			if (resp.status < 200 || (resp.status >= 300 && resp.status < 502))
				// It's expected for session_start to return UserNotFound error to denote user isn't registered
				if (urlPath !== 'users/session_start' || !json || !json.error || json.error.code !== ErrCode.UserNotFound)
					this.metrics.apiErrorCount.add(1);
				else if (resp.error_code === 1211)
					this.metrics.timeoutCount.add(1);
				else if (resp.error_code)
					this.metrics.networkErrorCount.add(1);
			if (!resp.status || resp.status < 500)
				break;
			-- tries;
			Utils.delayRange(1, 5);
			if (tries > 0)
				logger.warn('GET ' + urlPath + ' retrying after ' + JSON.stringify(json));
		}
		return json;
	}

	public post(urlPath: string, body: unknown): IResponse {
		const refreshResp = this.refreshAuth();
		if (refreshResp && refreshResp.error)
			return refreshResp;
		let tries = 3;
		let json = {} as IResponse;	// Initialize to an empty response to silence a warning - will definitely be re-assigned
		while (tries) {
			const resp = http.post(
				this.urlBase + urlPath,
				JSON.stringify(body),
				{
					/* eslint-disable @typescript-eslint/naming-convention */
					headers: {
						'Content-Type': 'application/json',
						'Authorization': 'Bearer ' + this.accessToken,
						'X-TU-device-Id': '00000000-0000-0000-0000-000000000000'
					}
					/* eslint-enable @typescript-eslint/naming-convention */
				}
			);
			logger.trace('POST ' + urlPath + ' ' + resp.status + ': ' + resp.body);
			logger.trace('resp=' + JSON.stringify(resp));
			json = Utils.parseResponseBody(resp);
			logger.trace('json=' + JSON.stringify(json));
			if (resp.status < 200 || (resp.status >= 300 && resp.status < 502))
				// It's expected for session_start to return UserNotFound error to denote user isn't registered
				if (urlPath !== 'users/session_start' || !json || !json.error || json.error.code !== ErrCode.UserNotFound)
					this.metrics.apiErrorCount.add(1);
				else if (resp.error_code === 1211)
					this.metrics.timeoutCount.add(1);
				else if (resp.error_code)
					this.metrics.networkErrorCount.add(1);
			if (!resp.status || resp.status < 500)
				break;
			-- tries;
			Utils.delayRange(1, 5);
			if (tries > 0)
				logger.warn('POST ' + urlPath + ' retrying after ' + JSON.stringify(json));
		}
		return json;
	}
}
