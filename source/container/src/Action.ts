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

	public constructor(weight: number, name: string, func: () => ActionResult) {
		this.name = name;
		this.weight = weight;
		this.trigger = 0;
		this.func = func;
	}
}

export class ActionError extends Error {
}

export class ActionFatalError extends Error {
}

export class ActionSet {
	public name: string;
	public actions: Action[];

	// For debugging - force selection of certain actions in order
	private static forcedActions: { setName: string; conditional: boolean; actionName: string}[];
	private static forcedActionIndex = -1;

	public constructor(name: string, actions: (Action|Action[]|null)[]) {
		this.name = name;
		this.actions = [];
		actions.forEach(action => {
			if (Array.isArray(action))
				this.actions.concat(...action);
			else if (action != null)
				this.actions.push(action);
		});
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
	}

	public dispatch(): ActionResult {
		if (ActionSet.forcedActions && ActionSet.forcedActionIndex >= 0 && ActionSet.forcedActionIndex < ActionSet.forcedActions.length) {
			const desc = ActionSet.forcedActions[ActionSet.forcedActionIndex];
			if (this.name === desc.setName) {
				++ ActionSet.forcedActionIndex;
				return this.dispatchAction(desc.actionName);
			} else if (desc.conditional)
				++ ActionSet.forcedActionIndex;
		}
		const maxRetries = config.maxActionRetries || 10;
		let retry = 0;
		while (true) {
			const chance = Math.random();
			const action = this.actions.find(a => chance <= a.trigger);
			if (!action)
				throw Error(`Action not found for ${this.name} weight ${chance}!`);
			logger.debug(`Dispatching ${this.name} action ${action.name}`);
			const result = action.func();
			if (result !== ActionResult.Skipped)
				return result;
			++ retry;
			if (retry > maxRetries)
				return result;
		}
	}

	/**
	 * Force actions to be dispatch, in a given order, mostly for debugging. The
	 * descriptors are in in "<setName>[?].<actionName>" format. The question
	 * mark denotes a conditional - thr action will be skipped instead of
	 * waiting for the next match.
	 */
	public static forceActions(actionDescriptors: string[]): void {
		ActionSet.forcedActions = actionDescriptors.map(d => {
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
		ActionSet.forcedActionIndex = 0;
	}

	public dispatchAction(name: string): ActionResult {
		const action = this.actions.find(a => a.name === name);
		if (!action)
			throw Error(`Action ${name} not found for ${this.name}!`);
		logger.debug(`Dispatching explicit ${this.name} action ${action.name}`);
		return action.func();
	}
}
