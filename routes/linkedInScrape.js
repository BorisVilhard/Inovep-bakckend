// import express from 'express';
// import scrapeLinkedInProfile from '../controllers/linkedInScraperController.js';

// const router = express.Router();

// router.get('/', async (req, res) => {
// 	const { profileURL } = req.query;

// 	if (!profileURL) {
// 		return res.status(400).json({ error: 'Profile URL is required' });
// 	}

// 	try {
// 		const profileData = await scrapeLinkedInProfile(profileURL);
// 		res.json(profileData);
// 	} catch (error) {
// 		res.status(500).json({ error: 'Fail ed to scrape LinkedIn profile' });
// 	}
// });

// export default router;
