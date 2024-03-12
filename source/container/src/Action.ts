import { config } from './Config';
import { Logger } from './Logger';

const logger = new Logger('Action');

export enum ActionResult {
	/** Success - continue executing next action */
	OK,
	/** Success - nothing to do so execute next action without any 'thinking' delay */
	Skipped,
	/** Handled an error - continue executing next action */
	Error,
	/** Leave current screen (tab) and choose another */
	LeaveScreen,
	/** Jump to matchups screen */
	GoToMatchups,
	/** Jump to home screen */
	GoToHome,
	/** Exit app (end current VU iteration) and pause */
	ExitApp,
	/** Fatal error - exit app then pause and restart (emulates astronaut screen) */
	FatalError,
	/** Iteration is complete after start of ramp-down period - sleep VU until k6 terminates */
	Done
}

export class Action {
	public name: string;
	public weight: number;
	public trigger: number;
	public func: () => ActionResult;
	public condition: (() => boolean)|undefined;

	public constructor(weight: number, name: string, func: () => ActionResult, condition?: () => boolean) {
		this.name = name;
		this.weight = weight;
		this.trigger = 0;
		this.func = func;
		this.condition = condition;
	}
}

export class ActionError extends Error {
}

export class ActionFatalError extends Error {
}

export class Dispatcher {
	public name: string;
	public actions: Action[];
	public noRepeats = false;
	private lastActionName: string|undefined;

	// For debugging - force selection of certain actions in order
	private static forcedActions: { setName: string; conditional: boolean; actionName: string}[];
	private static forcedActionIndex = -1;

	public constructor(name: string, actions: (Action|Action[]|null)[]) {
		this.name = name;
		const flatten = (actions: Action[], action: (Action|Action[]|null)[]): Action[] => {
			if (Array.isArray(action))
				action.forEach(a => flatten(actions, a as (Action|null)[]));
			else if (action != null)
				actions.push(action);
			return actions;
		};
		this.actions = flatten([], actions);
		const weights: Record<string, number> = config.actionWeights?.[this.name];
		if (weights) {
			for (const key in weights) {
				const action = this.actions.find(a => a.name === key);
				if (action)
					action.weight = weights[key];
			}
		}
		const totalWeight = this.actions.reduce<number>((v, a) => v + a.weight, 0);
		let total = 0;
		for (const action of this.actions) {
			action.trigger = total + action.weight / totalWeight;
			total = action.trigger;
		}
//		logger.debug(`Set ${name}:${this.actions.reduce<string>((v, a) => v + ` ${a.name}(${a.trigger})`, '')}`);
	}

	public dispatch(): ActionResult {
		if (Dispatcher.forcedActions && Dispatcher.forcedActionIndex >= 0 && Dispatcher.forcedActionIndex < Dispatcher.forcedActions.length) {
			const desc = Dispatcher.forcedActions[Dispatcher.forcedActionIndex];
			if (this.name === desc.setName) {
				++ Dispatcher.forcedActionIndex;
				return this.dispatchAction(desc.actionName);
			} else if (desc.conditional)
				++ Dispatcher.forcedActionIndex;
		}
		const maxRetries = config.maxActionRetries || 10;
		let retry = 0;
		while (true) {
			const chance = Math.random();
			const action = this.actions.find(a => chance <= a.trigger);
			if (!action)
				throw Error(`Action not found for ${this.name} weight ${chance}!`);
			if (this.noRepeats && action.name === this.lastActionName)
				continue;
			logger.debug(`* Action ${this.name}.${action.name}`);
			if (action.condition != null && !action.condition())
				continue;
			const result = action.func();
			if (result !== ActionResult.Skipped) {
				this.lastActionName = action.name;
				return result;
			}
			++ retry;
			if (retry > maxRetries) {
				this.lastActionName = action.name;
				return result;
			}
		}
	}

	/**
	 * Force action(s) to be dispatched, in a given order, mostly for debugging.
	 * The descriptors are in "<setName>[?].<actionName>" format. The question
	 * mark denotes a conditional - the action will be skipped instead of
	 * waiting for the next match.
	 */
	public static forceActions(actionDescriptors: string[]): void {
		Dispatcher.forcedActions = actionDescriptors.map(d => {
			const pair = d.split('.');
			if (pair[0].endsWith('?')) {
				return {
					setName: pair[0].slice(0, pair[0].length - 1),
					conditional: true,
					actionName: pair[1]
				};
			} else {
				return {
					setName: pair[0],
					conditional: false,
					actionName: pair[1]
				};
			}
		});
		Dispatcher.forcedActionIndex = 0;
	}

	public dispatchAction(name: string): ActionResult {
		const action = this.actions.find(a => a.name === name);
		if (!action)
			throw Error(`Action ${name} not found for ${this.name}!`);
		logger.debug(`! Action ${this.name}.${action.name}`);
		return action.func();
	}
}
