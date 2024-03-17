export function generateSpecialEvents(spec) {
	const events = [];
	if (spec.surge) {
		events.push(createSurge(spec.surgeLength));
	}
	if (spec.season) {
		events.push(createSeason(spec.seasonJoinWindow));
	}
	if (spec.realTime) {
		events.push(createRealTime(spec.realTimeJoinWindow));
	}
	if (spec.bestOfBlasteroids) {
		events.push(createBestOf('adhocBG', spec.miniRoyaleJoinWindow));
	}
	if (spec.bestOfCrystalCaverns) {
		events.push(createBestOf('adhocCC', spec.miniRoyaleJoinWindow));
	}
	if (spec.bestOfMagnetMadness) {
		events.push(createBestOf('adhocMM', spec.miniRoyaleJoinWindow));
	}
	if (spec.bestOfMonkeyBusiness) {
		events.push(createBestOf('adhocSG', spec.miniRoyaleJoinWindow));
	}
	if (spec.miniRoyaleCount) {
		for (let i = 0; i < spec.miniRoyaleCount; ++ i) {
			events.push(createMiniRoyale(i, spec.miniRoyaleJoinWindow));
		}
	}
	if (spec.hiddenEventCount) {
		for (let i = 0; i < spec.hiddenEventCount; ++ i) {
			events.push(createHidden(i, spec.miniRoyaleJoinWindow));
		}
	}
	if (spec.delayStarts) {
		const delaySpan = (spec.maxDelayMins - spec.minDelayMins) * 60 * 1000;
		const delayIncr = delaySpan / (events.length - 1);
		let minDelay = spec.minDelayMins * 60 * 1000;
		for (let i = 0; i < events.length; ++ i) {
			const delay = minDelay + i * delayIncr;
			events[i].startTs = `${Math.trunc(delay / (60 * 1000))}m${Math.trunc((delay % (60 * 1000)) / 1000)}s`;
		}
	}
	return events;
}

function createSurge(length) {
	return {
		type: 'surge',
		name: 'Surge',
		startTs: '',
		closeTs: '',
		endTs: length || '30m',
		status: 'upcoming'
	};
}

function createSeason(joinWindow) {
	return {
		type: 'adhocSeason',
		name: 'Season 5: Growing Jackpot',
		startTs: '',
		closeTs: joinWindow || '30m',
		endTs: '',
		status: 'upcoming',
		prizes: [
			{ name: 'PoolSplit', displayIcon: false, amount: 451223 },
			{ name: 'PoolSplit', displayIcon: false, amount: 53300 },
			{ name: 'PoolSplit', displayIcon: false, amount: 11869 },
			{ name: 'PoolSplit', displayIcon: false, amount: 6330 },
			{ name: 'PoolSplit', displayIcon: false, amount: 3957 },
			{ name: 'PoolSplit', displayIcon: false, amount: 2058 },
			{ name: 'PoolSplit', displayIcon: false, amount: 1108 },
			{ name: 'PoolSplit', displayIcon: false, amount: 475 },
			{ name: 'PoolSplit', displayIcon: false, amount: 238 },
			{ name: 'PoolSplit', displayIcon: false, amount: 119 },
			{ name: 'PoolSplit', displayIcon: false, amount: 48 },
			{ name: 'PoolSplit', displayIcon: false, amount: 25 },
			{ name: 'PoolSplit', displayIcon: false, amount: 13 },
			{ name: 'PoolSplit', displayIcon: false, amount: 8 },
			{ name: 'PoolSplit', displayIcon: false, amount: 5 },
			{ name: 'Secondary', displayIcon: false, amount: 10 }
		],
		prizePoolName: 'Tokens',
		prizePoolTotal: 916500,
		theme: 'seasonThemeB',
		hasSpecialPrize: false,
		joinCost: 10,
		joinCurrency: 'secondary',
		rejoinCost: 20,
		rejoinCostMax: 160,
		rejoinCurrency: 'secondary',
		isFeatured: true,
		seasonKey: 'Season 5'
	};
}

function createRealTime(joinWindow) {
	return {
		type: 'adhocQF',
		name: 'Real-Time Rumble',
		startTs: '',
		closeTs: joinWindow || '30m',
		endTs: '',
		status: 'upcoming',
		prizes: [
			{ name: 'PoolSplit', displayIcon: false, amount: 23 },
			{ name: 'PoolSplit', displayIcon: false, amount: 11 },
			{ name: 'PoolSplit', displayIcon: false, amount: 5 },
			{ name: 'PoolSplit', displayIcon: false, amount: 3 },
			{ name: 'PoolSplit', displayIcon: false, amount: 2 },
			{ name: 'Secondary', displayIcon: false, amount: 20 },
			{ name: 'Secondary', displayIcon: false, amount: 10 }
		],
		prizePoolName: 'BasicSpin',
		prizePoolTotal: 2000,
		theme: 'realTimeRumble',
		joinCost: 25,
		joinCurrency: 'secondary'
	};
}

function createBestOf(type, joinWindow) {
	const name = type === 'adhocBG'
		? 'Blasteroids'
		: type === 'adhocCC'
			? 'Crystal Caverns'
			: type === 'adhocMM'
				? 'Magnet Madness'
				: 'Monkey Business';
	return {
		type,
		name: `Best of ${name}`,
		startTs: '',
		closeTs: joinWindow || '30m',
		endTs: '',
		status: 'upcoming',
		prizes: [
			{ name: 'PoolSplit', displayIcon: false, amount: 17.9 },
			{ name: 'PoolSplit', displayIcon: false, amount: 5 },
			{ name: 'PoolSplit', displayIcon: false, amount: 1.2 },
			{ name: 'PoolSplit', displayIcon: false, amount: 0.7 },
			{ name: 'PoolSplit', displayIcon: false, amount: 0.45 },
			{ name: 'PoolSplit', displayIcon: false, amount: 0.29 },
			{ name: 'PoolSplit', displayIcon: false, amount: 0.17 },
			{ name: 'PoolSplit', displayIcon: false, amount: 0.08 },
			{ name: 'Secondary', displayIcon: false, amount: 40 },
			{ name: 'Secondary', displayIcon: false, amount: 35 },
			{ name: 'Secondary', displayIcon: false, amount: 30 },
			{ name: 'Secondary', displayIcon: false, amount: 20 }
		],
		prizePoolName: 'Tokens',
		prizePoolTotal: 4350,
		joinCost: 10,
		joinCurrency: 'secondary',
		rejoinCost: 20,
		rejoinCostMax: 100,
		rejoinCurrency: 'secondary',
	};
}

function createMiniRoyale(index, joinWindow) {
	const props = [
		{
			name: 'Mini-Royale',
			prizes: [
				{ name: 'PoolSplit', displayIcon: false, amount: 13 },
				{ name: 'PoolSplit', displayIcon: false, amount: 8 },
				{ name: 'PoolSplit', displayIcon: false, amount: 3.9 },
				{ name: 'PoolSplit', displayIcon: false, amount: 1.2 },
				{ name: 'PoolSplit', displayIcon: false, amount: 0.55 },
				{ name: 'PoolSplit', displayIcon: false, amount: 0.35 },
				{ name: 'PoolSplit', displayIcon: false, amount: 0.15 },
				{ name: 'PoolSplit', displayIcon: false, amount: 0.07 },
				{ name: 'PoolSplit', displayIcon: false, amount: 0.05 }
			],
			prizePoolName: 'Tokens',
			prizePoolTotal: 6850,
			joinCost: 225,
			joinCurrency: 'secondary',
			rejoinCost: 20,
			rejoinCostMax: 160,
			rejoinCurrency: 'secondary',
		},
		{
			name: 'Banana-Rama!',
			prizes: [
				{ name: 'PoolSplit', displayIcon: false, amount: 799 },
				{ name: 'PoolSplit', displayIcon: false, amount: 431 },
				{ name: 'PoolSplit', displayIcon: false, amount: 243 },
				{ name: 'PoolSplit', displayIcon: false, amount: 140 },
				{ name: 'PoolSplit', displayIcon: false, amount: 95 },
				{ name: 'PoolSplit', displayIcon: false, amount: 85 },
				{ name: 'PoolSplit', displayIcon: false, amount: 75 },
				{ name: 'PoolSplit', displayIcon: false, amount: 65 },
				{ name: 'PoolSplit', displayIcon: false, amount: 55 },
				{ name: 'PoolSplit', displayIcon: false, amount: 45 },
				{ name: 'PoolSplit', displayIcon: false, amount: 35 },
				{ name: 'PoolSplit', displayIcon: false, amount: 25 },
				{ name: 'PoolSplit', displayIcon: false, amount: 14 }
			],
			prizePoolName: 'Secondary',
			prizePoolTotal: 100000,
			theme: 'bananarama',
			rejoinCost: 10,
			rejoinCostMax: 80,
			rejoinCurrency: 'secondary',
			host: 'Coach Kong',
		},
		{
			name: 'VIP Special',
			prizes: [
				{ name: 'PoolSplit', displayIcon: false, amount: 201 },
				{ name: 'PoolSplit', displayIcon: false, amount: 53 },
				{ name: 'PoolSplit', displayIcon: false, amount: 30 },
				{ name: 'PoolSplit', displayIcon: false, amount: 13 },
				{ name: 'PoolSplit', displayIcon: false, amount: 8.1 },
				{ name: 'PoolSplit', displayIcon: false, amount: 4 },
				{ name: 'PoolSplit', displayIcon: false, amount: 1.9 },
				{ name: 'PoolSplit', displayIcon: false, amount: 0.7 },
				{ name: 'PoolSplit', displayIcon: false, amount: 0.33 },
				{ name: 'PoolSplit', displayIcon: false, amount: 0.15 }
			],
			prizePoolName: 'Tokens',
			prizePoolTotal: 47000,
			theme: 'vip',
			joinCost: 100,
			joinCurrency: 'primary',
			rejoinCost: 25,
			rejoinCostMax: 100,
			rejoinCurrency: 'primary',
		},
		{
			name: 'Follower Frenzy',
			prizes: [
				{ name: 'PoolSplit', displayIcon: false, amount: 2630 },
				{ name: 'PoolSplit', displayIcon: false, amount: 560 },
				{ name: 'PoolSplit', displayIcon: false, amount: 113 },
				{ name: 'PoolSplit', displayIcon: false, amount: 52 },
				{ name: 'PoolSplit', displayIcon: false, amount: 27 },
				{ name: 'PoolSplit', displayIcon: false, amount: 15 },
				{ name: 'PoolSplit', displayIcon: false, amount: 8 },
				{ name: 'PoolSplit', displayIcon: false, amount: 5 },
				{ name: 'PoolSplit', displayIcon: false, amount: 3 },
				{ name: 'PoolSplit', displayIcon: false, amount: 1.7 },
				{ name: 'Secondary', displayIcon: false, amount: 35 },
				{ name: 'Secondary', displayIcon: false, amount: 25 },
				{ name: 'Secondary', displayIcon: false, amount: 15 }
			],
			prizePoolName: 'Tokens',
			prizePoolTotal: 100000,
			theme: 'followerFrenzy',
			rejoinCost: 10,
			rejoinCostMax: 80,
			rejoinCurrency: 'secondary',
			isFeatured: true,
			inviteCode: 'FOLLOWUP',
		},
		{
			name: 'Bitcoin Bash',
			prizes: [
				{ name: 'Bitcoin', overrideText: '$300', displayIcon: true, amount: 300 },
				{ name: 'Tokens', displayIcon: false, amount: 500 },
				{ name: 'Tokens', displayIcon: false, amount: 200 },
				{ name: 'Tokens', displayIcon: false, amount: 100 },
				{ name: 'Tokens', displayIcon: false, amount: 50 },
				{ name: 'Tokens', displayIcon: false, amount: 25 },
				{ name: 'Tokens', displayIcon: false, amount: 15 },
				{ name: 'Tokens', displayIcon: false, amount: 7 },
				{ name: 'Tokens', displayIcon: false, amount: 3 },
				{ name: 'Secondary', displayIcon: false, amount: 30 },
				{ name: 'Secondary', displayIcon: false, amount: 25 },
				{ name: 'Secondary', displayIcon: false, amount: 20 },
				{ name: 'Secondary', displayIcon: false, amount: 15 },
				{ name: 'Secondary', displayIcon: false, amount: 10 }
			],
			theme: 'bitcoinBash',
			joinCost: 25,
			joinCurrency: 'secondary',
			rejoinCost: 15,
			rejoinCostMax: 120,
			rejoinCurrency: 'secondary',
		},
		{
			name: 'LightLink Levitation',
			prizes: [
				{ name: 'LightLink', overrideText: '$5,000 of $10,000 Prize Pool', displayIcon: true, amount: 5000 },
				{ name: 'LightLink', overrideText: '$500.00', displayIcon: true, amount: 500 },
				{ name: 'LightLink', overrideText: '$250.00', displayIcon: true, amount: 250 },
				{ name: 'LightLink', overrideText: '$100.00', displayIcon: true, amount: 100 },
				{ name: 'LightLink', overrideText: '$75.00', displayIcon: true, amount: 75 },
				{ name: 'LightLink', overrideText: '$50.00', displayIcon: true, amount: 50 },
				{ name: 'LightLink', overrideText: '$30.00', displayIcon: true, amount: 30 },
				{ name: 'LightLink', overrideText: '$20.00', displayIcon: true, amount: 20 },
				{ name: 'Secondary', overrideText: '', displayIcon: false, amount: 50 },
				{ name: 'Secondary', displayIcon: false, amount: 40 },
				{ name: 'Secondary', displayIcon: false, amount: 30 },
				{ name: 'Secondary', displayIcon: false, amount: 20 },
				{ name: 'Secondary', displayIcon: false, amount: 10 }
			],
			theme: 'lightlinkLevitation',
			rejoinCost: 20,
			rejoinCostMax: 80,
			rejoinCurrency: 'secondary',
//			hasLearnAndEarn: true,
//			learnAndEarn: {
//				sponsorDescription: 'LightLink is an Ethereum Layer 2 blockchain that supports ZERO-GAS TRANSACTIONS. With Lightlink Enterprise Mode, developers can build on a secure, user-friendly blockchain without transaction fees or other typical development friction.\n' +
//					'\n' +
//					'The prize pool for this tournament is $10,000 USD worth of LightLink tokens upon their forthcoming generation event (expected during this tournament). Players in some geographies may be required to accept an alternative prize or prize currency, subject to regulatory circumstances. See event details for more.',
//				questionsAndAnswers: [
//					{
//						question: 'LightLink Enterprise Mode allows blockchain developers to:',
//						correctAnswer: 'Enjoy zero-gas transactions',
//						incorrectAnswers: [
//							'Bend space and time',
//							'Vacuum a 3-bedroom apartment',
//							"Dance like nobody's watching"
//						]
//					}
//				]
//			},
			host: 'LightLink',
			isFeatured: true,
		},
		{
			name: 'Gaming Chronicles Clash',
			prizes: [
				{ name: 'TallyUpMug', overrideText: '$100 + GC Pass NFT ($500 value)', displayIcon: false, amount: 1 },
				{ name: 'Tokens', displayIcon: false, amount: 10000 },
				{ name: 'Tokens', displayIcon: false, amount: 1500 },
				{ name: 'Tokens', displayIcon: false, amount: 600 },
				{ name: 'Tokens', displayIcon: false, amount: 200 },
				{ name: 'Tokens', displayIcon: false, amount: 75 },
				{ name: 'Tokens', displayIcon: false, amount: 35 },
				{ name: 'Tokens', displayIcon: false, amount: 15 },
				{ name: 'Secondary', displayIcon: false, amount: 40 },
				{ name: 'Secondary', displayIcon: false, amount: 25 },
				{ name: 'Secondary', displayIcon: false, amount: 10 }
			],
			theme: 'gamingChroniclesClash',
			rejoinCost: 20,
			rejoinCostMax: 80,
			rejoinCurrency: 'secondary',
			host: 'Gaming Chronicles',
			inviteCode: 'GC2024',
		}
	];
	if (index > props.length - 1)
		return;
	return {
		type: 'adhocMini',
		name: 'Mini-Royale',
		joinType: 'joinWindow',
		startTs: '',
		closeTs: joinWindow || '30m',
		endTs: '',
		status: 'upcoming',
		prizes: [
			{ name: 'Tokens', displayIcon: false, amount: 1 }
		],
		...props[index]
	};
}

function createHidden(index, joinWindow) {
	index += 1;
	const numDigits = 4;
	return {
		type: 'adhocMini',
		name: `Private ${('0000' + index).slice(-numDigits)}`,
		joinType: 'joinWindow',
		startTs: '',
		closeTs: joinWindow || '30m',
		endTs: '',
		status: 'upcoming',
		prizes: [
			{ name: 'Tokens', displayIcon: false, amount: index + 1 }
		],
		inviteCode: `INVITE${('0000' + index).slice(-numDigits)}`,
		isHidden: true
	};
}
