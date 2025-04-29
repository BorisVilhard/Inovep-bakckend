export const getPlanByName = (planName) => {
	const plans = {
		Bronz: {
			name: 'Bronz',
			price: 59,
			tokensPerMonth: 2,
			visibilityDays: 30,
			canTop: false,
			topDays: 0,
			jobLimit: 2,
			role: 'company',
		},
		Silver: {
			name: 'Silver',
			price: 99,
			tokensPerMonth: 5,
			visibilityDays: 30,
			canTop: true,
			topDays: 7,
			jobLimit: 5,
			role: 'company',
		},
		Gold: {
			name: 'Gold',
			price: 179,
			tokensPerMonth: 10,
			visibilityDays: 40,
			canTop: true,
			topDays: 14,
			jobLimit: 10,
			role: 'company',
		},
		Standart: {
			name: 'Standart',
			price: 9.9,
			tokensPerMonth: 1,
			visibilityDays: 30,
			canTop: false,
			topDays: 0,
			jobLimit: 1,
			role: 'regular',
		},
		Premium: {
			name: 'Premium',
			price: 19.9,
			tokensPerMonth: 1,
			visibilityDays: 30,
			canTop: true,
			topDays: 10,
			jobLimit: 1,
			role: 'regular',
		},
		Free: {
			name: 'Free',
			price: 0,
			tokensPerMonth: 1,
			visibilityDays: 10,
			canTop: false,
			topDays: 0,
			jobLimit: 1,
			role: 'free',
		},
	};

	if (!planName || !plans[planName]) {
		return null;
	}

	return plans[planName];
};
