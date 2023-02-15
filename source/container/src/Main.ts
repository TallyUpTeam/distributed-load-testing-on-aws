import { sleep } from 'k6';
import http from 'k6/http';
import { Options } from 'k6/options';
import { API } from './API';
import { Client } from './Client';
import { Cognito } from './Cognito';
import { config } from './Config';
import { Logger } from './Logger';
import { Metrics } from './Metrics';
import { Utils } from './Utils';

const logger = new Logger('Main');

// Export an initial set of options for k6 to use.
// NOTE: k6 will later populate or override properties of this with consolidated
// options, including those derived from here, env vars, and command line args.
// See https://k6.io/docs/using-k6/k6-options/how-to/
export const options: Options = config;
options.thresholds = {
	cognitoThrottles: [{ threshold: 'count < 1', abortOnFail: true }]
};

const metrics = new Metrics();

const startTime = Date.now();

// Export a single default function for k6 ro use as the entry point.
export default function (): void {
	if (!options.stages || options.stages.length < 3)
		return;
	const testDuration = options.stages.map(s => Utils.parseDuration(s.duration)).reduce((t, d) => (t || 0) + (d || 0)) || 0;
	const rampDownDuration = Utils.parseDuration(options.stages[options.stages.length - 1].duration) || 0;
	const startRampDownElapsed = testDuration - rampDownDuration;

	// Burn our first VU as a heartbeat monitor to send logs to CloudWatch every 10
	// seconds, along with a metric that can be graphed on a dashboard
	// TODO: Use k6's new statsd output and CloudWatch agent instead
	if (config.heartbeat && __VU === 1) {
		if (testDuration) {
			const url = config.stack === 'local' ? 'http://localhost:8080/health' : `https://${config.stack}-api.tallyup.com/health`;
			let succ = 0;
			let fail = 0;
			const start = Date.now();
			let elapsed = 0;
			while (elapsed < testDuration) {
				const resp = http.get(url, { timeout: 10000 });
				if (resp.status === 200)
					++succ;
				else
					++fail;
				console.log(`${succ} succ ${fail} fail ${resp.timings.duration / 1000} avg rt`);
				sleep(10);
				elapsed = Date.now() - start;
			}
			return;
		}
	}
	metrics.sessionCount.add(1);
	const start = Date.now();
	const numberBase = (parseInt(__ENV.TASK_INDEX) || 0) * (options.vusMax || 1);
	logger.debug('Base number: ' + numberBase);
	const phone = Utils.getPhoneNumber(numberBase + __VU - 1);
	logger.info('Task: ' + (__ENV.TASK_INDEX || 0) + ', VU: ' + __VU + ', phone: ' + phone);

	const idp = new Cognito(config.clientStackData[config.stack].clientId);
	const api = new API(idp, metrics, config.clientStackData[config.stack].urlBase);
	const client = new Client(api, metrics, phone, startTime, testDuration, startRampDownElapsed, rampDownDuration, options.vusMax || 1);

	client.session();
	metrics.sessionLength.add(Date.now() - start);
}
