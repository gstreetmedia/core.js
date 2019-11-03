const ControllerBase = require('./ViewControllerBase');
const _ = require('lodash');

class ViewController extends ControllerBase {
	constructor() {
		super();
	}

	async login(req, res){
		return await super.index(req, res);
	}

}

module.exports = ViewController;