const express = require('express');
const router = express.Router();
const usersController = require('../../controllers/usersController');

// Improved route definitions
router.route('/').get(usersController.getAllUsers);
// Assuming a POST method for creating a user

router
	.route('/:id')
	.get(usersController.getUser)
	.put(usersController.updateUser)
	.delete(usersController.deleteUser);

module.exports = router;
