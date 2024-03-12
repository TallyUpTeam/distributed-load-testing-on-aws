import { sleep } from 'k6';
import { config } from './Config';
import { Logger } from './Logger';

const logger = new Logger('Utils');
const enableDelays = config.enableDelays;

export interface IResponseErrorData {
	code?: number;
	method?: string;
	msg?: string;
	status?: number;
	target?: string;
	url?: string;
}

export interface IResponse {
	error?: IResponseErrorData,
	[ key: string ]: any;	// eslint-disable-line @typescript-eslint/no-explicit-any
}

export class Utils {
	/* eslint-disable @typescript-eslint/no-explicit-any */
	public static parseResponseBody(resp: any): IResponse {
		let json: IResponse = {};
		if (resp.body && (typeof resp.body === 'string' || resp.body instanceof String) && (resp.body[0] === '{' || resp.body[0] === '[')) {
			json = JSON.parse(resp.body);
		}
		if (resp.error) {
			if (!json.error)
				json.error = {};
			json.error.msg = resp.error;
		}
		if (resp.status < 200 || resp.status >= 300) {
			if (!json.error)
				json.error = {};
			json.error.status = resp.status;
			if (!json.error.msg)
				json.error.msg = 'HTTP status ' + resp.status;
		}
		if (resp.error_code && json.error?.code == null) {
			if (!json.error)
				json.error = {};
			json.error.code = resp.error_code;
			if (resp.error_code === 1211 && !json.error.msg)
				json.error.msg = 'Timeout';
		}
		if (json.error) {
			json.error.method = resp.request.method;
			json.error.url = resp.request.url;
			if (resp.request.headers && resp.request.headers['x-amz-target'])
				json.error.target = resp.request.headers['x-amz-target'];
		}
		return json;
	}
	/* eslint-enable @typescript-eslint/no-explicit-any */

	public static getPhoneNumber(n: number): string {
		const area = Math.trunc(n / 100);
		if (area > 999)
			throw new Error(`Number too big (${n})`);
		const number = 100 + n % 100;
		return '+1' + ('00' + area).substr(-3, 3) + '5550' + number;
	}

	public static getNumberFromPhone(phone: string): number {
		return Math.trunc(Math.max(0, parseInt(phone.substring(2, 5) + phone.substring(10)) || 0));
	}

	public static getUsernameFromNumber(n: number): string {
		if (n > 99999)
			throw new Error(`Number too big (${n})`);
		return 'load_' + ('0000' + n).substr(-5, 5);
	}

	public static getUsernameFromPhone(phone: string): string {
		return this.getUsernameFromNumber(this.getNumberFromPhone(phone));
	}

	public static parseDuration(dur: string): number|undefined {
		if (dur == null)
			return undefined;
		const str = dur.toString();
		let duration = 0;
		const ms = str.match(/([.\d]+)ms/);
		const s = str.match(/([.\d]+)s/);
		const m = str.match(/([.\d]+)m($|[^s])/);
		const h = str.match(/([.\d]+)h/);
		const d = str.match(/([.\d]+)d/);
		if (ms) duration += parseInt(ms[1]);
		if (s) duration += parseInt(s[1]) * 1000;
		if (m) duration += parseInt(m[1]) * 60 * 1000;
		if (h) duration += parseInt(h[1]) * 60 * 60 * 1000;
		if (d) duration += parseInt(d[1]) * 24 * 60 * 60 * 1000;
		return duration;
	}

	/**
	 * If option enableDelays is true, then delay for a random period between
	 * min and max. If enableDelays is false, then delay for exactly minSecs.
	 * @param {number} minSecs Minimum delay in seconds
	 * @param {number} maxSecs Maximum delay in seconds
	 */
	public static delayRange(minSecs: number, maxSecs: number): void {
		const sleepTime = enableDelays
			? (maxSecs - minSecs) * Math.random() + minSecs
			: minSecs;
		logger.trace('sleepTime=' + sleepTime);
		sleep(sleepTime);
	}

	/**
	 * Always delay by given amount.
	 * @param {number} secs Fixed delay in seconds
	 */
	public static delay(secs: number): void {
		const sleepTime = secs;
		logger.trace('sleepTime=' + sleepTime);
		sleep(sleepTime);
	}

	public static randomInRange(min: number, max: number): number {
		return min + (max - min) * Math.random();
	}
}
