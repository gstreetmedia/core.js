const fs = require("fs");
const path = require("path");

if (!fs.existsSync(path.resolve(global.appRoot + "/src/middleware/authentication.js"))) {
	console.log("using core authentication");
	let AuthenticationModel = require("../model/AuthenticationModel");
	let m = new AuthenticationModel();
	module.exports = async function (req, res, next) {
		try {
			if (req.isAuth === true) {
				if (next) {
					return next();
				}
			}
			let result = await m.verify(req);

			if (result.error) {
				return res.error(result.error);
			}

			req.isAuth = true;

			if (next) {
				next();
			}
		} catch (e) {
			console.log(e);
			res.error("Unknown Server Error", 500);
		}
	}

} else {
	module.exports = require(global.appRoot + "/src/middleware/authentication");
}