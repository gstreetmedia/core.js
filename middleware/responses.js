let now = require("../../core/helper/now");

module.exports = async function (req, res, next) {

	let startTime = new Date();
	//add more stuff you want

	res.success = (result)=>  {
		let now = new Date();
		let obj = {
			success:true,
			results:result,
			time : now.getTime() - startTime.getTime(),

		};
		if (req.limit) {
			obj.limit = req.limit;
		}
		if (req.offset >= 0) {
			obj.offset = req.offset;
		}
		if (req.count) {
			obj.count = req.count;
		}
		if (result instanceof Array) {
		  obj.records = result.length;
    }
		res.status(200).send(obj);
	};

	res.created = (result) => {
		let now = new Date();
		let obj = {
			success:true,
			results:result,
			time : now.getTime() - startTime.getTime(),

		};

		res.status(201).send(obj)
	};

	res.error = (e) => {
		if (e.statusCode) {
			res.status(e.statusCode).send(e);
		} else {
			res.status(500).send(e);
		}
	};

	res.withStatus = (status, result)=> {
		let now = new Date();

		let obj = {
			success:status === 200 || status === 201 ? "success" : false,
			results:result,
			time : now.getTime() - startTime.getTime(),

		};

		res.status(status).send(obj);
	}

	res.notFound = (e)=> {
		res.status(404).send(e);
	};

	res.notAllowed = (message)=> {
		res.status(401).send({
			error:true,
			message: message || "Not authorized"
		});
	};

	res.invalid = (message)=> {
		//console.log(message);
		if (typeof  message === "object") {
			return res.status(400).send(message)
		}
		res.status(400).send({error:true,message:message});
	};

	res.file = (path) => {
		let now = new Date();
		let time = now.getTime() - startTime.getTime();

		res.sendFile(path,
			{
				cacheControl : true,
				maxAge : 365 * 24 * 60 * 60 * 1000,
				headers : {
					"execution-time" : time
				}
			}
		);
	}

	/**
	 * For use with rate limiting
	 * @param retryAfter
	 * @returns {*}
	 */
	res.tooManyRequests = (retryAfter)=> {
		res.set('Retry-After', String(retryAfter));
		return res.status(429).send('Too Many Requests');
	};

	next();
}