import { Counter, Trend, Rate } from 'k6/metrics';

export class Metrics {
	public sessionCount = new Counter('sessions');
	public sessionLength = new Trend('session_duration', true);
	public matchmakingDelay = new Trend('matching_delay', true);
	public asyncGameStarts = new Counter('async_game_starts');
	public asyncGameAccepts = new Counter('async_game_accepts');
	public asyncGameDeclines = new Counter('async_game_declines');
	public asyncGameMoves = new Counter('async_game_moves');
	public asyncGameCompletes = new Counter('async_game_completes');
	public liveGameCount = new Counter('live_games');
	public liveGameLength = new Trend('live_game_duration', true);
	public roundDelay = new Trend('round_delay', true);
	public botsPercentage = new Rate('bots_percent');
	public basicSpinCount = new Counter('basic_spins');
	public megaSpinCount = new Counter('mega_spins');
	public noSpinsCount = new Counter('no_spins');
	public networkErrorCount = new Counter('network_errors');
	public apiErrorCount = new Counter('api_errors');
	public timeoutCount = new Counter('timeouts');
	public cognitoThrottleCount = new Counter('cognitoThrottles');
	public homeScreenCount = new Counter('home_screen');
	public activityScreenCount = new Counter('activity_screen');
	public settingsScreenCount = new Counter('settings_screen');
	public goalsScreenCount = new Counter('arcade_screen');
	public eventsScreenCount = new Counter('events_screen');
	public eventDetailsScreenCount = new Counter('event_details_screen');
	public socialScreenCount = new Counter('matchups_screen');
	public pvpScreenCount = new Counter('pvp_screen');
	public goalAwardsClaimedCount = new Counter('goal_awards_claimed');
	public eventPrizesClaimedCount = new Counter('event_prizes_claimed');
	public replaysWatchedCount = new Counter('replays_watched');
	public liveGameCancelRequestsCount = new Counter('live_game_cancel_requests');
	public powerPlaySettingsScreenCount = new Counter('powerplay_settings_screen');
}
