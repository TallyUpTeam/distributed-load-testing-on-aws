import { config } from './Config';

export enum LogLevel {
	Critical,
	Error,
	Warn,
	Info,
	Debug,
	Trace
}

export class Logger {
	private name: string;
	private logLevel: number;

	public constructor(name: string, logLevel?: number | string) {
		this.name = name;
		let level: number | string = LogLevel.Info;
		if (logLevel != null) {
			level = logLevel;
		} else {
			if (config && config.logLevels) {
				level = config.logLevels[this.name];
				if (level == null)
					level = config.logLevels['*'];
			}
		}
		if (Number.isInteger(level))
			this.logLevel = level as number;
		else if (typeof level === 'string')
			this.logLevel = LogLevel[<keyof typeof LogLevel>level];
		else
			throw new Error(`logLevel must be a string or integer`);
	}

	private log(level: number, message: string): void {
		if (level <= this.logLevel) {
			switch (level) {
			case LogLevel.Trace:
			case LogLevel.Debug:
			case LogLevel.Info:
				console.log((__VU ? __VU : '') + ': ' + message);
				break;
			case LogLevel.Warn:
				console.warn((__VU ? __VU : '') + ': ' + message);
				break;
			default:
				console.error((__VU ? __VU : '') + ': ' + message);
				break;
			}
		}
	}

	public critical(message: string): void {
		this.log(LogLevel.Critical, message);
	}

	public error(message: string): void {
		this.log(LogLevel.Error, message);
	}

	public warn(message: string): void {
		this.log(LogLevel.Warn, message);
	}

	public info(message: string): void {
		this.log(LogLevel.Info, message);
	}

	public debug(message: string): void {
		this.log(LogLevel.Debug, message);
	}

	public trace(message: string): void {
		this.log(LogLevel.Trace, message);
	}
}
