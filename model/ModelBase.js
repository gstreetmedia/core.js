const moment = require("moment-timezone");
const now = require("../helper/now");
const uuid = require("node-uuid");
const _ = require("lodash");
const inflector = require("../helper/inflector");
const processType = require("../helper/process-type");
const validateAgainstSchema = require("../helper/validate-against-schema");
const md5 = require("md5");
const connectionStringParser = require("../helper/connection-string-parser");
const getSchema = require("../helper/get-schema");
const getFields = require("../helper/get-fields");
const EventEmitter = require("events");
const cacheManager = require("../helper/cache-manager");
const trimObject = require("../helper/trim-object");

class ModelBase extends EventEmitter {

	/**
	 * @param schema - json schema for this model
	 * @param primaryKey - optional primary key, defaults to id
	 * @param req - the express request (or other object). looking for the request context really. req.role = "api-user"
	 * or req.account.id etc.
	 */
	constructor(req) {
		super();
		this.req = req;
		if (req && req.connectionString) {
			this._connectionString = req.connectionString;
		}
	}

	static getFields(tableName) {
		return getFields(tableName);
	}

	static getSchema(tableName) {
		return getSchema(tableName);
	}

	set tableName(value) {
		this._tableName = value;
	}

	get tableName() {
		if (this._tableName) {
			return this._tableName;
		}
		//return this.schema.tableName;

		let name = this.constructor.name.split("Model").join("");
		this._tableName = inflector.underscore(inflector.pluralize(name));
		return this._tableName;
	}

	get schema() {
		if (global.schemaCache && global.schemaCache[this.tableName]) {
			return global.schemaCache[this.tableName]
		}
		if (this._schema) {
			return this._schema;
		}
		return getSchema(this.tableName);
	}

	set schema(_value) {
		this._schema = value;
	}

	get fields() {
		if (global.fieldCache && global.fieldCache[this.tableName]) {
			return global.fieldCache[this.tableName]
		}
		if (this._fields) {
			return this._fields;
		}
		return getFields(this.tableName);
	}

	set fields(_value) {
		this._fields = value;
	}

	get properties() {
		return this.schema.properties;
	}

	get primaryKey() {
		return this.schema.primaryKey;
	}

	get connectionString() {

		if (this._connectionString) {
			return this._connectionString;
		}

		let dataSource = this.dataSource || this.schema.dataSource;

		//Allow for generic naming like DEFAULT_DB
		if (process.env[dataSource]) {
			this._connectionString = process.env[dataSource];
		}

		//TODO Convert this to use a connection string parser

		for (let key in process.env) {

			if (process.env[key].indexOf("postgresql://") === -1 &&
				process.env[key].indexOf("mysql://") === -1 &&
				process.env[key].indexOf("mssql://") === -1) {
				continue;
			}

			let cs = connectionStringParser(process.env[key]);

			if (!cs) {
				console.log("Unknown connection string type");
				continue;
			}

			if (cs.database === dataSource) {
				this._connectionString = process.env[key];
				break;
			}
		}

		return this._connectionString || process.env.DEFAULT_DB;
	}

	/**
	 *
	 * @returns {Pool}
	 */
	async getPool(action) {
		if (this.connectionString.indexOf("postgresql://") === 0) {
			this.db = "pg";
			return await require("../helper/postgres-pool")(this.connectionString);
		} else if (this.connectionString.indexOf("mysql://") === 0) {
			this.db = "mysql"
			return await require("../helper/mysql-pool")(this.connectionString);
		} else if (this.connectionString.indexOf("mssql://") === 0) {
			this.db = "mssql"
			return await require("../helper/mssql-pool")(this.connectionString);
		}

		//TODO Elastic, Redis
	}

	/**
	 * Create a query builder in the DB flavor of choice
	 * @returns {module.QueryToSql|*}
	 */
	get queryBuilder() {
		if (this._builder) {
			return this._builder;
		}

		let builder;

		if (this.connectionString.indexOf("postgresql://") !== -1) {
			builder = require("../helper/query-to-pgsql");
		} else if (this.connectionString.indexOf("postgres://") !== -1) {
			builder = require("../helper/query-to-pgsql");
		} else if (this.connectionString.indexOf("mysql://") !== -1) {
			builder = require("../helper/query-to-mysql");
		} else if (this.connectionString.indexOf("mssql://") !== -1) {
			builder = require("../helper/query-to-mssql");
		}

		if (!builder) {
			console.log("Could not determine connection type ");
			//console.log(this.connectionString);
		}

		this._builder = new builder(this);
		return this._builder;
		//TODO MSSQL, ElasticSearch, Mongo, Redis
	}

	addPrimaryKeyToQuery(id, query) {
		query.where = query.where || {};
		if (_.isArray(this.primaryKey)) {
			id = id.split("|");
			if (id.length !== this.primaryKey.length) {
				return {
					error : {
						message : "Missing parts for primary key. Got " + id.length + " expected " + this.primaryKey.length,
						statusCode : 500
					}
				}
			}
			this.primaryKey.forEach(
				(key) => {
					query.where[key] = id[0];
					id.shift();
				}
			)
		} else {
			query.where[this.primaryKey] = id;
		}
	}

	/**
	 *
	 * @param id
	 * @param query - used to pass in select & join
	 * @returns {Promise<*>}
	 */
	async read(id, query, cache) {

		let cacheKey;
		if (cache === true) {
			cacheKey = this.tableName + "::" + id;
			if (query) {
				cacheKey += "::" + md5(JSON.stringify(query));
			}
			let record = await cacheManager.get(cacheKey);
			if (record) {
				return record;
			}
		}

		let obj = {
			where: {},
			select : null
		};

		this.addPrimaryKeyToQuery(id, obj);

		if (query && query.select) {
			obj.select = query.select;
			this.addJoinFromKeys(query, obj);
		}

		let command = this.queryBuilder.select(obj);

		let result = await this.execute(command);

		if (result.error) {
			return result;
		}

		if (result.length === 1) {
			result = result[0];
			result = await this.afterRead(result);
			if (query && query.join) {
				result = await this.join(result, query);
			}
			if (cacheKey) {
				await cacheManager.set(cacheKey, result);
			}
			return result;
		} else if (result.length === 0) {
			return null;
		}
	}

	/**
	 * create a new record
	 * @param data
	 * @returns {Promise<*>}
	 */
	async create(data) {

		this.checkPrimaryKey(data);

		//TODO need some timestamp field by model
		if (this.properties[this.createdAt]) {
			data[this.createdAt] = now();
		}

		let params = this.convertDataTypes(data);

		let invalid = this.validate(params);

		if (invalid !== true) {
			return {
				error: {
					invalid: invalid,
					data: data,
					action: "create"
				}
			};
		}

		let required = this.checkRequiredProperties(params, "create");

		if (required !== true) {
			return {
				error: {
					missing: required,
					data: data,
					action: "create"
				}
			};
		}

		await this.beforeCreate(params);
		this.emit("beforeCreate", params);

		let command = this.queryBuilder.insert(params);

		if (command.error) {
			return command;
		}

		let result = await this.execute(command);

		if (result.error) {
			return result;
		}

		let record = await this.read(data[this.primaryKey]);

		await this.afterCreate(data[this.primaryKey], record);
		this.emit("create", data[this.primaryKey], record);

		return record;
	}

	/**
	 * Shorthand method for determining if a create or an update is necessary
	 * @param query
	 * @param data
	 * @returns {Promise<void|*>}
	 */
	async upsert(query, data) {
		let result = this.findOne(query);
		if (result) {
			return await this.update(result.id, data);
		} else {
			return await this.create(data);
		}
	}

	/**
	 * Update one record
	 * @param id
	 * @param data
	 * @param fetch
	 * @returns {Promise<void>}
	 */
	async update(id, data, fetch) {

		let exists = await this.exists(id);

		if (exists) {

			if (this.properties[this.updatedAt]) {
				data[this.updatedAt] = now();
			}

			let params = this.convertDataTypes(data);

			let required = this.checkRequiredProperties(params, "update");

			if (required !== true) {
				return {
					error: {
						missing: required,
						data: data,
						action: "update"

					}
				};
			}

			let invalid = this.validate(params);

			//console.log(invalid);

			if (invalid !== true) {
				return {
					error: {
						invalid: invalid,
						data: data,
						action: "update"
					}
				};
			}

			//console.log(params);

			let query = {};
			this.addPrimaryKeyToQuery(id, query);

			if (params[this.primaryKey]) {
				delete params[this.primaryKey]; //you can't change primary Keys. Don't even try!!!
			}

			let proceed = await this.beforeUpdate(id, params);
			this.emit("beforeUpdate", params);

			if (proceed) {

				let command = this.queryBuilder.update(query, params);

				let result = await this.execute(command);

				if (result.error) {
					return result;
				}

				let record = await this.read(id);

				await this.afterUpdate(id, record);
				this.emit("update", id, record);

				if (fetch) {
					return record;
				}

				return {
					id: id,
					action: "update",
					success: true
				}
			} else {
				return {
					error: "Update blocked by BeforeUpdate",
					[this.primaryKey]: id
				}
			}

		} else {
			return {
				error: {
					id: id,
					message: "Does not exist"
				}
			};
		}
	}

	async updateWhere(query, data) {

		data[this.updatedAt] = now();

		let params = this.convertDataTypes(data);
		let required = this.checkRequiredProperties(params, "update");

		if (required !== true) {
			return {
				error: {
					missing: required,
					data: data,
					action: "updateWhere"
				}
			};
		}

		let invalid = this.validate(params);

		if (invalid !== true) {
			return {
				error: {
					invalid: invalid,
					data: data,
					action: "updateWhere"
				}
			};
		}

		let command = this.queryBuilder.update(query, params);
		let result = await this.execute(command);

		if (result.error) {
			return result;
		}
		return result;
	}

	/**
	 * search for one or more records
	 * @param query
	 * @returns {Promise<*>}
	 */
	async query(query, cache) {
		let cacheKey;
		if (cache === true) {
			cacheKey = this.tableName + "::" + md5(JSON.stringify(query));
			let record = await cacheManager.get(cacheKey);
			if (record) {
				return record;
			}
		}

		let obj = _.clone(query);

		if (query && query.select) {
			obj.select = query.select;
			this.addJoinFromKeys(query, obj);
		}

		let command = this.queryBuilder.select(obj);

		if (_.isArray(query.sql)) {
			query.sql.forEach(
				(item) => {
					let key = Object.keys(item)[0];
					switch (key) {
						case "join" :
							command.joinRaw(item[key].query);
							if (item[key].where) {
								command.whereRaw(item[key].where);
							}
							this.debug = true;
							break;
						case "where" :
							command.whereRaw(item[key].query);
							break;
						case "group" :
							command.groupByRaw(item[key].query);
							break;
						case "having" :
							command.havingRaw(item[key].query);
							break;
					}
				}
			)
		}

		let result = await this.execute(command, this.queryBuilder.postProcess);

		if (result.error) {
			return result;
		}

		await this.afterFind(result);

		if (query.join) {
			result = await this.join(result, query);
		}

		if (cacheKey) {
			await cacheManager.set(cacheKey, result);
		}

		return result;
	}



	/**
	 *
	 * @param query
	 * @returns {Promise<*>}
	 */
	async count(query, cache) {
		let cacheKey;
		let result;

		if (cache === true) {
			cacheKey = this.tableName + "_count_" + md5(JSON.stringify(query));
			result = await cacheManager.get(cacheKey);
			if (result) {
				return result;
			}
		}

		let command = this.queryBuilder.count(query);
		result = await this.execute(command);

		if (result.error) {
			return result;
		}

		if (result) {
			if (this.db === "pg" && result[0].count) {
				result = result[0].count;
			} else {
				let key = Object.keys(result[0]);
				result = result[0][key];
			}
			if (cacheKey) {
				await cacheManager.set(cacheKey, result);
			}
			return result;
		} else {
			return 0;
		}
	}

	/**
	 * Psuedo for query
	 * @param query
	 * @returns {Promise<*>}
	 */
	async find(query, cache) {
		let cacheKey;
		let results;
		if (cache === true) {
			cacheKey = this.tableName + "-" + md5(JSON.stringify(query));
			results = await cacheManager.get(cacheKey);
			if (results) {
				return results;
			}
		}
		results = await this.query(query);

		if (results.error) {
			return results;
		}

		if (cacheKey) {
			await cacheManager.set(cacheKey, results);
		}

		return results;
	}

	/**
	 * Query to find one record
	 * @param query
	 * @returns {Promise<*>}
	 */
	async findOne(query, cache) {
		//console.log("findOne");
		query.limit = 1;
		let cacheKey;
		let result;

		if (cache === true) {
			cacheKey = this.tableName + "-" + md5(JSON.stringify(query));
			result = await cacheManager.get(cacheKey);
			if (result) {
				return result;
			}
		}

		result = await this.query(query);

		if (result.error) {
			return result;
		}

		if (result && result.length > 0) {
			if (cacheKey) {
				await cacheManager.set(cacheKey, result[0]);
			}

			return this.afterRead(result[0]);
		}

		return null;
	}

	/**
	 * destroy one record
	 * @param id
	 * @returns {Promise<*>}
	 */
	async destroy(id) {

		let record = await this.read(id);

		if (record) {

			let proceed = await this.beforeDestroy(id, record);
			this.emit("beforeDestroy", id, record);

			if (proceed !== false) {
				let query = {};
				this.addPrimaryKeyToQuery(id, query);
				let command = this.queryBuilder.delete(query);

				let result = await this.execute(command);

				await this.afterDestroy(id, record);
				this.emit("afterDestroy", id, record);

				return result;
			} else {
				return {
					error: "Blocked by beforeDestroy",
					tableName: this.tableName,
					id: id
				}
			}

		}
		return {
			error: "Record Not Found",
			tableName: this.tableName,
			id: id
		}


	}

	/**
	 * Delete one or more matching records
	 * @param query
	 * @returns {Promise<*>}
	 */
	async destroyWhere(query) {
		let command = this.queryBuilder.delete(query);
		this.emit("beforeDestroyWhere", query);
		let result = await this.execute(command);
		return result;
	}

	/**
	 * get an index of records by an optional key value pair
	 * @param key
	 * @param value
	 * @returns {Promise<*>}
	 */
	async index(query) {
		let keys = Object.keys(this.properties);

		if (query.select && _.isString(query.select)) {
			query.select = query.select.split(",");
		}

		if (query.select) {
			query.select = _.intersection(query.select, keys);
		}

		if (!query.select || query.select.length === 0) {
			query.select = _.intersection(['id', 'updatedAt', 'status'], keys);
		}

		delete query.join;

		return await this.query(query);
	}

	/**
	 * Does a record with the id exist
	 * @param id
	 * @returns {Promise<boolean>}
	 */
	async exists(id) {

		let query = {
			where : {},
			limit : 1
		};
		this.addPrimaryKeyToQuery(id, query);

		let command = this.queryBuilder.select(query);

		this.lastCommand = command;

		let result = await this.execute(command);
		if (result.length === 1) {
			return true
		}
		return false;
	}

	/**
	 * Shorthand method for updating one column in a row
	 * @param id
	 * @param key
	 * @param value
	 * @returns {Promise<*>}
	 */
	async setKey(id, key, value) {
		let obj = {}
		obj[key] = value;

		if (!await this.exists(id)) {
			return null;
		}

		let query = {
			where: {
			}
		};
		this.addPrimaryKeyToQuery(id, query);

		let command = this.queryBuilder.update(
			query,
			{
				[key]: value
			}
		);

		try {
			let result = await this.execute(command, this.queryBuilder.postProcess);
			return result;
		} catch (e) {
			//console.log(command.toString());
			console.log(e);
			return null;
		}
	}

	/**
	 * Get the value of a single column from a single row
	 * @param id
	 * @param key
	 * @returns {Promise<*>}
	 */
	async getKey(id, key) {
		let query = {
			where: {
			}
		};
		this.addPrimaryKeyToQuery(id, query);
		let command = this.queryBuilder.select(
			{
				query,
				select: [key]
			}
		);

		try {
			let result = await this.execute(command, this.queryBuilder.postProcess);
			return result;
		} catch (e) {
			console.log(e);
			return null;
		}
	}

	/**
	 * If the primary key is a UUID and missing, create one
	 * @param data
	 * @returns {Promise<void>}
	 */
	checkPrimaryKey(data) {
		//console.log(this.properties[this.primaryKey]);
		if (!data[this.primaryKey]) {
			switch (this.properties[this.primaryKey].type) {
				case "string" :
					switch (this.properties[this.primaryKey].format) {
						case "uuid" :
							data[this.primaryKey] = uuid.v4();
					}
				case "number" :
					if (!this.properties[this.primaryKey].autoIncrement) {
						//TODO shouldn't we get the next
					}
			}
		}
	}

	/**
	 * Make sure all the required keys of a join are present in the select.
	 * @param query
	 * @param obj
	 */
	addJoinFromKeys(query, obj) {
		if (!query) {
			return;
		}
		if (query.join) {
			let keys;
			let context = this;
			obj.select = obj.select || [];
			if (query.join === "*") {
				keys = Object.keys(this.relations);
			} else {
				keys = Object.keys(query.join);
			}
			keys.forEach(
				(k) => {
					if (!context.relations[k]) {
						return;
					}
					obj.select.push(context.relations[k].join.from)
					if (context.relations[k].where) {
						let whereKeys = Object.keys(context.relations[k].where);
						obj.select = obj.select.concat(whereKeys);
					}
				}
			)
			obj.select = _.uniq(obj.select);
		}

	}

	/**
	 * Run secondary queries for relations and foreign keys
	 * @param results
	 * @param query
	 * @returns {Promise<void>}
	 */
	async join(results, query) {

		//console.log("join " + this.tableName);

		if (!this.relations && !this.foreignKeys) {
			return results;
		}

		let relations = this.relations || {};
		let foreignKeys = this.foreignKeys || {};
		let fromIndex = {};
		let findOne = false;

		if (!_.isArray(results)) {
			results = [results];
			findOne = true;
		}

		let join = _.clone(query.join);
		let fullJoin = false;

		if (join === "*") {
			fullJoin = true;
			join = Object.keys(relations);
			join = join.concat(Object.keys(foreignKeys));
		}

		if (_.isString(join)) {
			let items = join.split(",");
			join = {};
			items.forEach(
				function (item) {
					join[item] = {
						where: {}
					};
				}
			)
		} else if (_.isArray(join)) {
			let temp = {};
			join.forEach(
				function (item) {
					temp[item] = {
						where: {}
					}
				}
			);
			join = temp;
		} else if (_.isObject(join)) {
			//console.log("JOIN IS AN OBJECT");
			//not sure is there is anything to do here
			//console.log("Condition 3");
		}

		//console.log("Before Loop");
		//console.log(join);

		let keys = Object.keys(join);

		/**
		 * @param key
		 * @param j
		 */
		let processWhere = (key, j)=> {
			if (relations[key].where) {
				j.where = j.where || {};
				for (let p in relations[key].where) {
					let expression = j.where[p] || relations[key].where[p];
					if (_.isString(expression)) {
						expression = {"=":expression}
					}
					let compare = Object.keys(expression)[0];
					if (expression[compare].indexOf("{{") === 0) {
						let targetKey = expression[compare].replace("{{", "").replace("}}","");
						try {
							if (results[0][targetKey]) {
								expression[compare] = results[0][targetKey];
							}
						} catch (e) {
							console.log("processWhere issue join " + targetKey);
							console.log(results);
						}
					}
					j.where[p] = expression;
				}
			}
		}

		/**
		 * Add any selects defined in the relation
		 * @param key
		 * @param j
		 */
		let processSelect = (key, j) => {
			if (relations[key].select) {
				j.select = j.select || [];
				relations[key].select.forEach(
					(field) => {
						j.select.push(field)
					}
				);
				j.select = _.uniq(j.select);
			}
		}

		/**
		 * If a select was present remove extra keys from join
		 * @param results
		 * @param key
		 * @param originalSelect
		 */
		let processExtras = (results, key, originalSelect) => {
			if (results &&
				results.length > 0 &&
				results[0][key] &&
				originalSelect &&
				originalSelect.length > 0) {
				let keys = Object.keys(results[0][key]);
				for(let i = 0; i < results.length; i++) {
					keys.forEach((field)=> {
							if (originalSelect.indexOf(field) === -1) {
								delete results[i][key][field];
							}
						}
					);
				}
			}
		};

		while (keys.length > 0) {
			let key = keys[0];

			if (relations[key]) {

				if (join[key] === true) {
					join[key] = {}
				} else if (join[key] === false) {
					console.log("remove join " + key);
					keys.shift();
					continue;
				}

				let list;
				let m;
				let throughList;
				let item = relations[key];
				let originalSelect = item.join.select ? _.clone(item.join.select) : null;
				let joinFrom = item.join.from;
				let joinTo = item.join.to;
				let joinThroughFrom = item.join.through ? item.join.through.from : null;
				let joinThroughTo = item.join.through ? item.join.through.to : null;
				let joinThroughWhere = item.join.through ? item.join.through.where : null;
				let joinThroughSort = item.join.through ? item.join.through.sort : null;

				let removeJoinTo = false; //keys not requested

				let targetKeys = [];
				let joinFromKeys = {};
				let joinThroughFromKeys = {};
				let joinThroughToKeys = {};
				let joinToKeys = {};

				//TODO we need a more flexible from, to, from to that supports arrays
				/**
				 * eg. from : ["key1","key2"] to: ["key3", "key4"]
				 */
				/*
				if (_.isArray(joinFrom)) {
					let i = 0;
					joinFrom.forEach(
						(joinFromItem) => {
							let items = _.map(results, joinFromItem);
							joinFromKeys[joinFromItem] = items;
							joinToKeys[joinTo[i]] = items;
							i++;
						}
					)
					console.log(joinFromKeys);
					return;
				} else if (joinFrom.indexOf(".") !== -1) {

				} else {
					let items = _.map(results, joinFrom);
					joinToKeys[joinTo] = items;
					joinFromKeys[joinFrom] = items;
				}

				 */

				for (let i = 0; i < results.length; i++) { //grab the primary keys from the
					if (joinFrom.indexOf(".") !== -1 && _.get(results[i], joinFrom, null)) {
						//Allow for join on json value
						let value = _.get(results[i], joinFrom, null);
						targetKeys.push(value);
						fromIndex[value] = i;
					} else if (results[i] && results[i][joinFrom]) {
						if (_.isArray(results[i][joinFrom])) {
							targetKeys = targetKeys.concat(results[i][joinFrom]);
						} else {
							targetKeys.push(results[i][joinFrom]);
						}
						fromIndex[results[i][joinFrom]] = i;
					}
				}

				targetKeys = _.uniq(targetKeys);

				///console.log("!!!!!!!!!!!!!!!!TargetKeys => " + targetKeys);
				//console.log("joinFrom => " + joinFrom);
				//console.log("joinThroughTo => " + joinThroughTo);
				//console.log("joinThroughFrom => " + joinThroughFrom);
				//console.log("joinTo => " + joinTo);

				if (item.throughClass) { //build new targetKey based on the pivot table
					const ThroughModel = this.loadModel(item.throughClass);
					let throughModel = new ThroughModel(this.req);
					let joinThrough = _.clone(join[key]);
					joinThrough.where = joinThroughWhere || {};
					joinThrough.where[joinThroughFrom] = {in: targetKeys};
					joinThrough.select = [joinThroughFrom, joinThroughTo];
					joinThrough.sort = joinThroughSort || null;
					joinThrough.sql = item.join.through.sql || null;
					if (joinThrough.debug) {
						throughModel.debug = true;
					}
					throughList = await throughModel.query(joinThrough);
					if (throughList.length === 0) {
						keys.shift();
						continue;
					}
					targetKeys = _.uniq(_.map(throughList, joinThroughTo));
					targetKeys = _.flatten(targetKeys);
					targetKeys = _.uniq(targetKeys);
					//console.log("!!!!!!!!!!!!!!!!Target Table => " + throughModel.tableName);
					//console.log(targetKeys);

				}

				let j = _.clone(join[key]);
				//keep a copy so we can clean out non selected props


				switch (item.relation) {

					case "HasOne":

						//console.log("HasOne " + key);

						let HasOneModel = this.loadModel(item.modelClass);
						let hasOneModel = new HasOneModel(this.req);

						if (j.debug) {
							hasOneModel.debug = true;
						}

						if (relations[key].where) {
							processWhere(key, j);
						}

						j.where = j.where || {};
						j.where[joinTo] = {in: targetKeys};
						j.sort = j.sort || null;
						j.limit = j.limit || relations[key].limit || targetKeys.length;
						j.sql = relations[key].sql || null;

						if (fullJoin) {
							j.join = "*"
						}

						if (!originalSelect || originalSelect.length === 0) {
							processSelect(key, j);
						}

						if (j.select && _.indexOf(j.select, joinTo) === -1) {
							j.select.push(joinTo);
							removeJoinTo = true;
						}

						list = await hasOneModel.query(j);

						if (list.error) {
							keys.shift();
							continue;
						}

						if (item.throughClass) {
							list.forEach(
								function (row) {
									let throughItems = [];
									throughList.forEach(
										function(item) {
											if (_.isArray(item[joinThroughTo])) {
												if (item[joinThroughTo].indexOf(row[joinTo]) !== -1) {
													throughItems.push(item)
												}
											} else if (item[joinThroughTo] === row[joinTo]) {
												throughItems.push(item);
											}
										}
									);
									throughItems.forEach(
										function(throughItem) {
											try {
												let resultsIndex;
												if (_.isArray(throughItem[joinThroughFrom])) {
													for (let i = 0; i < throughItem[joinThroughFrom].length; i++) {
														let k = throughItem[joinThroughFrom][i];
														if (k in fromIndex) {
															resultsIndex = fromIndex[k];
															break;
														}
													}
												} else {
													resultsIndex = fromIndex[throughItem[joinThroughFrom]];
												}
												if (removeJoinTo) {
													delete row[joinTo];
												}
												results[resultsIndex][key] = row;

											} catch (e) {
												console.log("join through error " + item.throughClass);
											}
										}
									)
								}
							)
						} else {
							for (let i = 0; i < list.length; i++) {
								//TODO Arrays
								let o = {[joinFrom]:list[i][joinTo]};
								for(let k = 0; k < results.length; k++) {
									let item = results[k];
									if (_.isArray(item[joinFrom]) && item[joinFrom].indexOf(list[i][joinTo]) !== -1) {
										results[k][key] = list[i];
									} else if (item[joinFrom] === list[i][joinTo]) {
										results[k][key] = list[i];
									}
								}
							}
						}

						processExtras(results, key, originalSelect);

						break;
					case "HasMany" :

						let HasManyModel = this.loadModel(item.modelClass);
						let hasManyModel = new HasManyModel(this.req);

						if (j.debug) {
							hasManyModel.debug = true;
						}

						if (relations[key].where) {
							processWhere(key, j);
						}

						j.where = j.where || {};
						if (joinFromKeys) {

						}
						j.where[joinTo] = {in: targetKeys};
						j.sort = relations[key].sort || null;
						j.offset = relations[key].offset || 0;
						j.limit = j.limit || relations[key].limit || null;
						j.sql = relations[key].sql || null;

						if (!originalSelect || originalSelect.length === 0) {
							processSelect(key, j);
						}

						//must select the targetJoin key
						if (j.select && _.indexOf(j.select, joinTo) === -1) {
							removeJoinTo = true;
							j.select.push(joinTo);
						}

						if (fullJoin) {
							j.join = "*"
						}

						j.sql = relations[key].sql;

						//console.log("condition 2 "  + this.tableName);
						//console.log("hasManyModel.tableName " + hasManyModel.tableName);
						//console.log(j);

						list = await hasManyModel.query(j);

						if (list.error) {
							keys.shift();
							continue;
						}

						if (item.throughClass) {
							list.forEach(
								function (row) {
									let throughItems = [];
									throughList.forEach(
										function(item) {
											if (_.isArray(item[joinThroughTo])) {
												if (item[joinThroughTo].indexOf(row[joinTo]) !== -1) {
													throughItems.push(item)
												}
											} else if (item[joinThroughTo] === row[joinTo]) {
												throughItems.push(item);
											}
										}
									)
									throughItems.forEach(
										function(throughItem){
											let resultsIndex;
											if (_.isArray(throughItem[joinThroughFrom])) {
												for (let i = 0; i < throughItem[joinThroughFrom].length; i++) {
													let k = throughItem[joinThroughFrom][i];
													if (k in fromIndex) {
														resultsIndex = fromIndex[k];
														break;
													}
												}
											} else {
												resultsIndex = fromIndex[throughItem[joinThroughFrom]];
											}

											results[resultsIndex][key] = results[resultsIndex][key] || [];
											let filter = {[item.join.to]:row[item.join.to]};
											if (!_.find(results[resultsIndex][key], filter)) {
												if (removeJoinTo) {
													delete row[joinTo];
												}
												results[resultsIndex][key].push(row);
											}
										}
									);
								}
							)
						} else {

							for (let i = 0; i < list.length; i++) {
								try {
									//If the joinFrom is an array, we need to recurse all results
									//to find out if the array of each matches the joinTo
									if(this.properties[joinFrom].type === "array") {
										for(let k = 0; k < results.length; k++) {
											if (results[k][joinFrom].includes(list[i][joinTo])) {
												results[k][key] = results[k][key] || [];
												results[k][key].push(list[i]);
											}
										}
									} else {
										for(let k = 0; k < results.length; k++) {
											if (results[k][joinFrom] === list[i][joinTo]) {
												results[k][key] = results[k][key] || [];
												results[k][key].push(list[i]);
											}
										}
									}
									/*


									try {
										if (!results[fromIndex[list[i][joinTo]]][key]) {
											results[fromIndex[list[i][joinTo]]][key] = [];
										}
									} catch(e) {
										console.log("something went wrong");
										console.log("joinTo -> " + joinTo);
										//console.log(list[i]);
									}

									let targetKey = list[i][joinTo];
									let value = list[i];

									if (removeJoinTo === true) {
										value = _.omit(value, joinTo);
									}

									try {
										results[fromIndex[targetKey]][key].push(value);
									} catch (e) {
										console.log(results);
										console.log(targetKey);
										console.log(fromIndex);
										console.log(e);
									}

									 */

								} catch (e) {
									console.log("Could not join " + key + " for " + this.tableName);
									console.log("joinTo => " + joinTo);
									//console.log(fromIndex);
									console.log(e);
									//console.log(j.select);
									//console.log(m.lastCommand.toString());
								}
							}
						}

						processExtras(results, key, originalSelect);

						break;
				}
			} else if (foreignKeys[key]) {

				//console.log("!!!!!!!!!!!!!!!!foreignKeys => " + key);

				let j = _.clone(foreignKeys[key]);

				let ForeignKeyModel = this.loadModel(foreignKeys[key].modelClass);
				if (!ForeignKeyModel) {
					console.warn("Foreign Key Join Error. " + key + " does not exist");
				}
				let foreignKeyModel = new ForeignKeyModel(this.req);
				if (join[key].debug || foreignKeys[key].debug) {
					foreignKeyModel.debug = true;
				}

				let idList = [];
				results.forEach(
					function (item) {
						if (item[key] !== null) {
							if (_.isArray(item[key])) {
								idList.concat(item[key]);
							} else {
								idList.push(item[key]);
							}
						}
					}
				);

				if (idList.length > 0) {
					idList = _.uniq(idList);

					let primaryKey = foreignKeys[key].to || foreignKeyModel.primaryKey;
					let q = {
						where: {
							[primaryKey]: {"in": idList}
						}
					};

					if (j.select) {
						q.select = j.select;
					}

					if (j.join) {
						q.join = _.clone(j.join);
					}

					let list = await foreignKeyModel.query(q);
					let context = this;

					if (!list.error) {
						list.forEach(
							function (item) {
								//TODO support hookup when the property is an array
								let matches = _.filter(results, {[key]: item[primaryKey]});
								matches.forEach(
									function (row) {
										row.foreignKeys = row.foreignKeys || {};
										row.foreignKeys[key] = item;
									}
								)

							}
						)
					}
				}
			}

			keys.shift();
		}

		//console.log("join complete " + this.tableName);

		if (findOne) {
			return results[0];
		}

		return results;
	}


	/**
	 * Converts any input types to the correct one (eg. string to int) and convert objects to JSON
	 * @param data
	 * @returns {Promise<void>}
	 */
	convertDataTypes(data) {
		let params = {};
		for (let key in data) {
			if (this.properties[key]) {
				params[key] = processType(data[key], this.properties[key]);
			} else {
				//console.log("unknown key " + key);
			}
		}
		return params;
	}


	/**
	 * Run through the data, compare against the schema, and make sure we have all the props with need
	 * @param data
	 * @param action
	 * @returns {Promise<*>}
	 */
	checkRequiredProperties(data, action) {
		if (action === "create") {
			let keys = [];

			for (let key in data) {
				if (!data[key] && this.properties[key].default) {
					if (this.properties[key].default === "now") {
						data[key] = now();
					} else {
						data[key] = this.properties[key].default;
					}
					keys.push(key);
				} else if (data[key]) {
					keys.push(key);
				}
			}

			let intersection = _.intersection(this.schema.required, keys); //keys found in input and required

			if (intersection.length < this.schema.required.length) {  //if the intersection is less than required, something is missing
				//these will be the values that are missing.
				let missing = _.difference(intersection, this.schema.required);
				if (missing.length > 0) {
					return missing
				} else {
					return true;
				}
			}

			return true;
		} else {
			let missing = [];
			for (let key in data) {
				if (data[key] === null && _.indexOf(this.schema.required, key) !== -1) {
					missing.push(key);
				}
			}
			if (missing.length > 0) {
				return missing;
			} else {
				return true;
			}
		}
	}

	/**
	 *
	 * @param data
	 * @returns {*}
	 */
	validate(data) {
		let invalid = [];
		for (let key in data) {

			if (!this.properties[key]) {
				console.log("validate => removing " + key);
				delete data[key];
				continue;
			}

			if (validateAgainstSchema(key, data, this.schema) === false) {
				if (data[key] === null && this.properties[key].allowNull === false) {
					console.log("Invalid 2 => " + key + " " + data[key]);
					invalid.push(key);
				} else if (_.indexOf(this.schema.required, key) !== -1 || data[key] !== null) {
					console.log("Invalid 2.1 " + this.tableName + " => " + key + " " + data[key]);
					invalid.push(key);
				}
			}
		}

		return invalid.length > 0 ? invalid : true;
	}

	convertToColumnNames(data) {
		let params = {};
		for (let key in data) {
			if (this.properties[key]) {
				params[this.properties[key].columnName] = data[key];
			}
		}

		return params;
	}

	/**
	 * Call the DB with query!!!
	 * @param command
	 * @param postProcess
	 * @returns {Promise<*>}
	 */
	async execute(command, postProcess) {
		let sql;
		try {
			sql = !_.isString(command) ? command.toString() : command;
		} catch (e) {
			return {
				error: e,
				message: "Error converting command to string"
			}
		}
		if (this.lastCommand === command) {
			//console.warn("Possible duplicate query");
		}
		this.lastCommand = command;

		if (this.debug) {
			console.log(sql.toString());
		}

		if (sql.toLowerCase().indexOf("select") === 0) {
			let pool = await this.getPool("read");

			try {
				let results = await pool.query(sql);

				if (results.recordset) { //mssql
					results = {
						rows: results.recordset
					}
				}

				//console.log("command.postProcess => " + postProcess);

				if (postProcess) {
					if (results.rows) {
						return this.postProcessResponse(results.rows);
					} else {
						return this.postProcessResponse(results);
					}
				} else {
					if (results.rows) {
						return trimObject(results.rows);
					} else {
						return results;
					}
				}

				//return results.rows;
			} catch (e) {
				this.lastError = e;
				e.sql = sql;
				console.log(sql);
				return {
					error: e
				};
			}
		} else {
			let pool = await this.getPool("write")
			try {
				let results = await pool.query(sql);

				if (results.recordset) { //mssql
					results = {
						rows: results.recordset
					}
				}

				if (results.rows) {
					return results;
				} else {
					return {
						rows: results
					};
				}

			} catch (e) {
				this.lastError = e;
				e.sql = sql;
				return {
					error: e
				};
			}

		}
	}


	getSelect(fieldset) {
		let rawfields = global.fieldCache[this.tableName][fieldset];

		let select = [];

		rawfields.forEach(
			function (item) {
				if (item.property && item.visible) {
					select.push(item.property);
				}
			}
		);

		return select;
	}

	/**
	 * Convert underscores back to camel case. Most of this would have happened in the creation of the SQL query,
	 * however if you appended anything raw to the end, those might not yet have been converted
	 * @param result
	 * @returns {*}
	 */
	postProcessResponse(result) {

		// TODO: add special case for raw results (depends on dialect)
		if (_.isArray(result)) {
			result.forEach(
				function (row) {
					for (let key in row) {
						if (key.indexOf("_") !== -1) {
							row[inflector.camelize(key, false)] = row[key];
							delete row[key];
						}
						if (key.indexOf(".") !== -1) {
							let parts = key.split(".");
							let doDeep = (pieces, obj) => {
								obj = obj || {};
								if (pieces.length === 0) {
									return obj;
								}
								obj[pieces[0]] = obj[pieces[0]] || {};
								console.log('parts => ' + _.isArray(pieces));
								return doDeep(pieces.shift(), obj);
							}
							let columnName = parts[0];
							parts.shift();
							row[columnName] = row[columnName] || {};
							console.log("parts here " + _.isArray(parts));
							console.log(row[columnName]);
							let target = doDeep(parts, row[columnName]);
							target = row[key];
						}
					}
				}
			)
		} else {
			for (let key in result) {
				if (key.indexOf("_") !== -1) {
					result[inflector.camelize(key, false)] = result[key];
					delete result[key];
				}
			}
		}
		return result;
	}

	/**
	 * Takes database result and converts it back to schema properties
	 * Use this when doing manual sql statements
	 * @param results
	 */
	convertResultsToSchema(results) {
		for (let i = 0; i < results.length; i++) {
			for (let key in results[i]) {
				for (let innerKey in this.properties) {
					if (this.properties[innerKey].column_name === key) {
						results[i][innerKey] = results[i][key];
						delete results[i][key];
					}
				}
			}
		}
	}

	/**
	 * Simple utility for creating a select prop_name as propName
	 * @param property
	 * @returns {string}
	 */
	selectAs(property) {
		return this.property[property].columnName + " as " + property;
	}

	async afterRead(result) {
		if (!result || result.error) {
			return result;
		}
		let r = await this.afterQuery([result]);
		return r[0];
	}

	async afterQuery(results) {
		if (!results || !_.isArray(results) || results.length === 0) {
			return results;
		}
		let keys = Object.keys(results[0]);
		if (keys.join("_").indexOf(".") === -1) {
			return results;
		}
		let hash = {};
		let hasElements;
		let context = this;
		keys.forEach(
			(key) => {
				if (key.indexOf(".") !== -1) {
					let parts = key.split(".");
					if (context.properties[parts[0]]) {
						hasElements = true;
						hash[key] = hash[key] || {
							field : parts[0],
							subfield : parts[1] //TODO can we go deeper than one level???
						}
					}
				}
			}
		);
		if (hasElements) {
			results.forEach(
				function(row) {
					keys.forEach(
						(key) => {
							if (hash[key]) {
								row[hash[key].field] = row[hash[key].field] || {};
								let value = row[key];
								try {
									value = JSON.parse(row[key]);
								} catch (e) {
									//Not JSON.
								}
								row[hash[key].field][hash[key].subfield] = value;
								delete row[key];
							}
						}
					)
					if (row.id && row.record) {
						row.record.id = row.id; //TODO this should be done during insert
					}
				}
			);
		}
		return results;
	}

	/**
	 * Before creating a record, pass the data over.
	 * This could be used to clean the data, check permission, etc
	 * @param data
	 * @returns {Promise<boolean>}
	 */
	async beforeCreate(data) {
		return true;
	}

	/**
	 * After the record has been created, you might want to do some additional work,
	 * like kick the record out to elastic search, or call some webhook
	 * @param id
	 * @param data
	 * @returns {Promise<void>}
	 */
	async afterCreate(id, data) {
		return;
	}

	/**
	 * Before updating a record, you may wish to modify the data, or check pmerissions
	 * @param id
	 * @param data
	 * @returns {Promise<boolean>}
	 */
	async beforeUpdate(id, data) {
		return true;
	}

	/**
	 * After the record has been created, you might want to do some additional work,
	 * like kick the record out to elastic search, or call some webhook
	 * @param id
	 * @param data
	 * @returns {Promise<void>}
	 */
	async afterUpdate(id, data) {
		return;
	}

	/**
	 * Before a record is destroyed, you might want to check permissions or run some process that if
	 * it fails, you wouldn't want to remove the record at this time.
	 * @param id
	 * @param data
	 * @returns {Promise<void>}
	 */
	async beforeDestroy(id, data) {
		return true;
	}



	/**
	 * Now that record is gone, maybe you want to move it to some log file, or history table
	 * @param id
	 * @param data
	 * @returns {Promise<void>}
	 */
	async afterDestroy(id, data) {
		return;
	}

	async afterFind(data) {
		if (this.afterQuery) {
			return await this.afterQuery(data)
		}
	}

	/**
	 * Override as needed to set the updatedAt column (if this table even has one). If this is complex, consider using beforeUpdate
	 * @returns {string}
	 */
	get updatedAt() {
		return "updatedAt";
	}

	/**
	 * Override as needed to set the createdAt column (if this table even has one). If this is complex, consider using beforeCreate
	 * @returns {string}
	 */
	get createdAt() {
		return "createdAt";
	}

	get relations() {
		return {};
	}

	get foreignKeys() {
		return {};
	}

	loadModel(modelName) {
		if (typeof modelName !== "string") {
			return modelName;
		}
		global.modelCache = global.modelCache || {};
		global.modelCache[modelName] = require("../../model/" + modelName);
		return global.modelCache[modelName];
	}

}

module.exports = ModelBase;
