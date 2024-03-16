import { config } from './Config';
import { API } from './API';
import { Logger } from './Logger';
import { IResponse, Utils } from './Utils';
import { IAdHocTournamentEntity, ISpecialEventEntity } from './tallyup-server/db/mongodb/entities/SpecialEventEntity';
import { SpecialEventJoinType, SpecialEventStatus, SpecialEventType } from './tallyup-server/models/types/SpecialEventTypes';

const logger = new Logger('SpecialEventsManager');

export class SpecialEventsManager {
	private api: API;

	public constructor(api: API) {
		this.api = api;
	}

	public init(): void {
		const now = new Date();

		// Cancel any currently-running events
		const resp = this.getRunningEvents();
		if (resp.success) {
			for(const event of resp.data) {
				logger.info(`Canceling ${event.name} of ${event.startTs}`);
				this.postCancelEvent(event._id);
			}
		}

		// Create new events for this test
		const testSuffix = `_${__ENV.TEST_ID}`;
		for (const event of config.events as ISpecialEventEntity[]) {
			if (!event.type) {
				continue;
			}
			if (!event.status) {
				event.status = SpecialEventStatus.Upcoming;
			}
			if (!event.joinType) {
				switch (event.type) {
				case SpecialEventType.Surge: event.joinType = SpecialEventJoinType.Global; break;
				case SpecialEventType.AdHocQuickFireTournament: event.joinType = SpecialEventJoinType.PreJoin; break;
				case SpecialEventType.AdHocTournamentOfChampions: event.joinType = SpecialEventJoinType.Admin; break;
				default: event.joinType = SpecialEventJoinType.JoinWindow; break;
				}
			}
			if (!event.name) {
				event.name = event.type;
			}
			this.fixupDate(event, 'startTs', now);
			if (!event.startTs) {
				event.startTs = now;
			}
			this.fixupDate(event, 'endTs', event.startTs);
			if (!event.endTs) {
				event.endTs = new Date('9999-12-31T23:59:59.999Z');	// Maximum value in ISO 8601
			}
			this.fixupDate(event, 'closeTs', event.startTs);
			if (!event.closeTs) {
				if (event.endTs) {
					event.closeTs = event.endTs;
				} else {
					event.closeTs = new Date('9999-12-31T23:59:59.999Z');
				}
			}

			// Fixup invite code to make it globally unique
			const adHocEvent = event as IAdHocTournamentEntity;	// This might not be true but it's harmless since we always test for existence of desired properties
			if (adHocEvent.inviteCode) {
				adHocEvent.inviteCode = adHocEvent.inviteCode + testSuffix;
			}

			logger.info(`Creating ${event.name}`);
			const resp = this.postCreateEvent(event);
			if (resp.error) {
				logger.error(JSON.stringify(resp.error));
			}
		}
		return;
	}

	private fixupDate(event: ISpecialEventEntity, field: keyof ISpecialEventEntity, start: Date): void {
		if (typeof event[field] === 'string' && (event[field] as string).length) {
			if (!(event[field] as string).endsWith('h') && !(event[field] as string).endsWith('m') && !(event[field] as string).endsWith('s'))
				(event[field] as string) += 'm';
			(event[field] as Date) = new Date(start.getTime() + (Utils.parseDuration(event[field] as string) || 0));
		} else if (typeof event[field] === 'number' && (event[field] as number) > 0) {
			(event[field] as Date) = new Date(start.getTime() + ((event[field] as number) * 60 * 1000));
		} else if (event[field] !== undefined) {
			delete event[field];
		}
	}

	private getRunningEvents(): IResponse {
		return this.api.get(`testing/special_events?filter=${encodeURIComponent('{ "status": "running" }')}`);
	}

	private postCancelEvent(id: string): IResponse {
		return this.api.post(`testing/special_events/${id}/cancel`, { });
	}

	private postCreateEvent(event: ISpecialEventEntity): IResponse {
		return this.api.post(`testing/special_events`, { event });
	}
}
