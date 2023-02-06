/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/naming-convention */

import http from 'k6/http';
import { Logger } from './Logger';
import { IResponse, Utils } from './Utils';

const logger = new Logger('Cognito');

export interface IIDPResponse extends IResponse {
	AuthenticationResult?: {
		AccessToken: string;
		ExpiresIn: number;
		RefreshToken: string;
	}
}

export interface IDP {
	signUp(phone: string): IResponse;
	initiateAuth(phone: string): IResponse;
	respondToAuthChallenge(phone: string, session: any): IIDPResponse;
	refreshAuth(phone: string, refreshToken: string): IIDPResponse;
}

export class Cognito implements IDP {
	private clientId;

	public constructor(clientId: string) {
		this.clientId = clientId;
	}

	public signUp(phone: string): IResponse {
		const resp = http.post(
			'https://cognito-idp.us-west-2.amazonaws.com/',
			JSON.stringify({ ClientId: this.clientId, Username: phone, Password: 'Password1!', UserAttributes: [{ Name: 'phone_number', Value: phone }] }),
			{
				headers: {
					'Content-Type': 'application/x-amz-json-1.1',
					'x-amz-api-version': '2016-04-18',
					'x-amz-target': 'AWSCognitoIdentityProviderService.SignUp'
				}
			}
		);
		logger.trace('POST https://cognito-idp.us-west-2.amazonaws.com/ (SignUp) ' + resp.status + ': ' + resp.body);
		return Utils.parseResponseBody(resp);
	}

	public initiateAuth(phone: string): IResponse {
		const resp = http.post(
			'https://cognito-idp.us-west-2.amazonaws.com/',
			JSON.stringify({ ClientId: this.clientId, AuthFlow: 'CUSTOM_AUTH', AuthParameters: { USERNAME: phone } }),
			{
				headers: {
					'Content-Type': 'application/x-amz-json-1.1',
					'x-amz-api-version': '2016-04-18',
					'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth'
				}
			}
		);
		logger.trace('POST https://cognito-idp.us-west-2.amazonaws.com/ (InitiateAuth) ' + resp.status + ': ' + resp.body);
		return Utils.parseResponseBody(resp);
	}

	public respondToAuthChallenge(phone: string, session: any): IIDPResponse {
		const resp = http.post(
			'https://cognito-idp.us-west-2.amazonaws.com/',
			JSON.stringify({ ClientId: this.clientId, Session: session, ChallengeName: 'CUSTOM_CHALLENGE', ChallengeResponses: { USERNAME: phone, ANSWER: '123456' } }),
			{
				headers: {
					'Content-Type': 'application/x-amz-json-1.1',
					'x-amz-api-version': '2016-04-18',
					'x-amz-target': 'AWSCognitoIdentityProviderService.RespondToAuthChallenge'
				}
			}
		);
		logger.trace('POST https://cognito-idp.us-west-2.amazonaws.com/ (RespondToAuthChallenge) ' + resp.status + ': ' + resp.body);
		return Utils.parseResponseBody(resp);
	}

	public refreshAuth(phone: string, refreshToken: string): IIDPResponse {
		const resp = http.post(
			'https://cognito-idp.us-west-2.amazonaws.com/',
			JSON.stringify({ ClientId: this.clientId, AuthFlow: 'REFRESH_TOKEN_AUTH', AuthParameters: { USERNAME: phone, REFRESH_TOKEN: refreshToken } }),
			{
				headers: {
					'Content-Type': 'application/x-amz-json-1.1',
					'x-amz-api-version': '2016-04-18',
					'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth'
				}
			}
		);
		logger.trace('POST https://cognito-idp.us-west-2.amazonaws.com/ (InitiateAuth) ' + resp.status + ': ' + resp.body);
		return Utils.parseResponseBody(resp);
	}
}
