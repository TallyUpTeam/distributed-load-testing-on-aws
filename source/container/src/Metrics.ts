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
	public pennyAwardedCount = new Counter('pennies');
	public noPennyCount = new Counter('no_pennies');
	public networkErrorCount = new Counter('network_errors');
	public apiErrorCount = new Counter('api_errors');
	public timeoutCount = new Counter('timeouts');
	public cognitoThrottleCount = new Counter('cognitoThrottles');
}
