// import puppeteer from 'puppeteer';
// import { ChatOpenAI } from '@langchain/openai';
// import { PromptTemplate } from '@langchain/core/prompts';
// import { HttpResponseOutputParser } from 'langchain/output_parsers';

// const EMAIL_TEMPLATE = `You are a marketing agency reaching out to potential clients.

// Client's Profile:
// Name: {name}
// Headline: {headline}
// About: {about}

// Write a personalized email to {name} offering marketing agency services based on their profile information. Include a friendly introduction, explain how your services can benefit them, and end with a call to action.`;

// async function scrapeLinkedInProfile(profileURL) {
// 	// Launch Puppeteer browser
// 	const browser = await puppeteer.launch({ headless: false });
// 	const page = await browser.newPage();
// 	const linkedInUsername = 'fastandfresh4u@gmail.com'; // Your LinkedIn username
// 	const linkedInPassword = '5IEG844o3'; // Your LinkedIn password

// 	try {
// 		// Go to LinkedIn login page
// 		await page.goto('https://www.linkedin.com/login', {
// 			waitUntil: 'domcontentloaded',
// 		});

// 		// Log in to LinkedIn
// 		await page.type('#username', linkedInUsername, { delay: 100 });
// 		await page.type('#password', linkedInPassword, { delay: 100 });
// 		await page.click('button[type="submit"]');

// 		// Wait for the home page to load
// 		await page.waitForNavigation({
// 			waitUntil: 'domcontentloaded',
// 			timeout: 120000,
// 		});

// 		// Navigate to the desired profile
// 		console.log('Navigating to profile:', profileURL);
// 		await page.goto(profileURL, {
// 			waitUntil: 'domcontentloaded',
// 			timeout: 120000,
// 		});

// 		// Wait for the profile name to load as an indication the page is ready
// 		await page.waitForSelector('.text-heading-xlarge', { timeout: 60000 });

// 		// Scrape the profile content
// 		const profileData = await page.evaluate(() => {
// 			const profile = {};
// 			profile.name =
// 				document.querySelector('.text-heading-xlarge')?.innerText || '';
// 			profile.headline =
// 				document.querySelector('.text-body-medium.break-words')?.innerText ||
// 				'';

// 			// Improved selector for the About section
// 			const aboutSection =
// 				document.querySelector('.pv-about-section') ||
// 				document.querySelector('.display-flex.ph5.pv3');
// 			profile.about = aboutSection
// 				? aboutSection.innerText
// 				: 'About section not found';

// 			return profile;
// 		});

// 		console.log('Profile data:', profileData);

// 		// Generate a personalized email based on the scraped profile data
// 		const personalizedEmail = await generatePersonalizedEmail(profileData);

// 		console.log('Generated Email:', personalizedEmail);

// 		return { profileData, personalizedEmail };
// 	} catch (error) {
// 		console.error('Error scraping LinkedIn profile:', error);
// 		throw error;
// 	} finally {
// 		// Close the browser
// 		await browser.close();
// 	}
// }

// async function generatePersonalizedEmail(profileData) {
// 	try {
// 		const prompt = PromptTemplate.fromTemplate(EMAIL_TEMPLATE);

// 		const model = new ChatOpenAI({
// 			apiKey: process.env.OPENAI_API_KEY,
// 			model: 'gpt-3.5-turbo',
// 			temperature: 0.7,
// 		});

// 		const parser = new HttpResponseOutputParser();
// 		const chain = prompt.pipe(model).pipe(parser);

// 		const stream = await chain.stream({
// 			name: profileData.name || 'Client',
// 			headline: profileData.headline || 'No headline available',
// 			about: profileData.about || 'No about section available',
// 		});

// 		const reader = stream.getReader();
// 		const decoder = new TextDecoder('utf-8');
// 		let emailText = '';

// 		while (true) {
// 			const { done, value } = await reader.read();
// 			if (done) break;
// 			emailText += decoder.decode(value, { stream: true });
// 		}

// 		return emailText.trim();
// 	} catch (error) {
// 		console.error('Error generating personalized email:', error);
// 		return 'Error generating personalized email.';
// 	}
// }

// // Example usage:
// scrapeLinkedInProfile('https://www.linkedin.com/in/boris-vilhard-3babab1aa')
// 	.then(({ profileData, personalizedEmail }) =>
// 		console.log(
// 			'Scraped Data:',
// 			profileData,
// 			'\nGenerated Email:',
// 			personalizedEmail
// 		)
// 	)
// 	.catch((error) => console.error('Error:', error));

// export default scrapeLinkedInProfile;
