const _ = require("lodash");
const moment = require("moment-timezone");
const uuid = require("node-uuid");
const inflector = require("inflected");
let knexProxy;

module.exports = class QueryToSql {

	/**
	 *
	 * @returns {string[]}
	 */
	static get keywords() {
		return ['sort', 'select', 'skip', 'offset', 'limit', 'sort', 'join', 'count'];
	}

	/**
	 *
	 * @returns {string}
	 */
	static get like() {
		return "like";
	}

	/**
	 *
	 * @returns {string}
	 */
	static get client() {
		return "mssql";
	}

	/**
	 *
	 * @returns {Knex.Client}
	 */
	static knex(tableName) {
		if (!knexProxy) {
			knexProxy = require("knex")(
				{
					client: QueryToSql.client,
					/**
					 * convert camelCase to snake_case. Note: wrap command in knex.raw() if you don't want this to happen
					 * @param value
					 * @param origImpl
					 * @param queryContext
					 * @returns {*}
					 */
					wrapIdentifier: (value, origImpl, queryContext) => {
						if (value.indexOf("_") === -1) {
							//console.log(value + " => " + inflector.underscore(value));
							value = inflector.underscore(value);
						}
						return origImpl(value);
					}
				}
			);
		}
		if (tableName) {
			return knexProxy(tableName);
		} else {
			return knexProxy;
		}
	}
	/**
	 * Generate SQL select statement
	 * @param table - the name of the table (optional);
	 * @param query - {where:{field:{">":"value"}}
	 * @param properties - the properties from the JSON schema
	 * @returns {*}
	 */
	static select(table, query, properties) {

		let queryBuilder = QueryToSql.parseQuery(table, query, properties);

		if (!query.select) {
			for (let key in properties) {
				//note: must wrap in knex.raw or it will be passed to the wrapIdentifier function
				queryBuilder.select(QueryToSql.knex().raw('"' + table + '"."' + properties[key].columnName + '" as "' + key + '"'));
			}
		} else if (query.select) {
			query.select = typeof query.select === "string" ? query.select.split(',') : query.select;
			for (let i = 0; i < query.select.length; i++) {
				let key = query.select[i];
				if (properties[key]){
					//note: must wrap in knex.raw or it will be passed to the wrapIdentifier function
					queryBuilder.select(QueryToSql.knex().raw('"' + table + '"."' + properties[key].columnName + '" as "' + key + '"'));
				} else if (key.indexOf('as') != -1) {
					//allow bypass of column names and assume the developer knows what they are doing
					queryBuilder.select(QueryToSql.knex().raw(key));
				}
			}
			delete query.select;
		}

		for (let key in query) {

			if (query[key] === "") {
				continue;
			}

			query[key] = QueryToSql.decodeQuery(query[key]);

			switch (key) {
				case "skip" :
				case "offset" :
					queryBuilder.offset(parseInt(query[key]));
					break;
				case "limit" :
					queryBuilder.limit(parseInt(query[key]));
					break;
				case "sort" :
					//TODO we might not want to worry about ASC, DESC just check for presence
					let params = query[key].split(" ");
					let direction = "ASC";
					if (properties[params[0]]) {
						if (params.length > 1) {
							if (params[1].toLowerCase() === "desc") {
								direction = "DESC";
							}
						}
						queryBuilder.orderBy(properties[params[0]].columnName, direction);
					}
					break;
				case "select" :
					break;
			}
		}

		//console.log(queryBuilder.toString());

		return queryBuilder;
	}

	static count(table, key, query, properties) {
		//console.log("key " + key);
		let sqlBuilder = QueryToSql.parseQuery(table, query, properties);
		return sqlBuilder.count(QueryToSql.knex().raw(properties[key].columnName));
	}

	/**
	 * General sqlBuilder update statement
	 * @param {string} table
	 * @param {Object} query
	 * @param {Object} properties
	 * @param {Object} data - the data to insert
	 * @returns {*}
	 */

	//this.tableName, query, data, this.properties
	static update(table, query, data, properties) {
		let sqlBuilder = QueryToSql.parseQuery(table, query, properties);
		let transform = {};

		//TODO should data have been validated before this? Seems like it
		for (var key in data) {
			if (properties[key]) {
				transform[properties[key].columnName] = QueryToSql.processType(data[key], properties[key]);
			}
		}

		sqlBuilder.update(transform);
		return sqlBuilder;
	}

	//this.tableName, query, data, this.properties
	static delete(table, query, data, properties) {
		let sqlBuilder = QueryToSql.parseQuery(table, query, properties);
		let transform = {};

		//TODO should data have been validated before this? Seems like it
		for (var key in data) {
			if (properties[key]) {
				transform[properties[key].columnName] = QueryToSql.processType(data[key], properties[key]);
			}
		}

		sqlBuilder.delete();
		return sqlBuilder;
	}

	/**
	 *
	 * @param table
	 * @param primaryKey
	 * @param data
	 * @param schema
	 * @returns {*}
	 */
	static insert(table, primaryKey, data, schema) {
		console.log("insert");

		let sqlBuilder = QueryToSql.knex(table);
		let translation = {};
		var properties = schema.properties;
		var required = _.clone(schema.required);

		if (primaryKey) {
			if (!data[primaryKey]) {
				if (properties[primaryKey].type === "string" && properties[primaryKey].format === "uuid") {
					data[primaryKey] = uuid.v4();
				}
			}
		}

		//TODO should data have been validated before this? Seems like it
		for (var key in data) {
			if (properties[key]) {
				//does final json conversion as needed
				translation[properties[key].columnName] = QueryToSql.processType(data[key], properties[key]);
			}
			let index = _.indexOf(required, key);
			if (index !== -1) {
				required.splice(index, 1);
			}
		}

		if (required.length > 0) {
			throw new Error(required);
		}

		sqlBuilder.insert(translation);

		return sqlBuilder;
	}

	/**
	 * A query to sqlBuilder conversion manager
	 * @param {string} table
	 * @param {Object} query
	 * @param {Object} properties
	 * @returns {*}
	 */
	static parseQuery(table, query, properties) {
		//TODO support complex or conditions

		let sqlBuilder;

		if (table) {
			sqlBuilder = QueryToSql.knex(table);
		} else {
			sqlBuilder = QueryToSql.knex()
		}

		if (!query) {
			return sqlBuilder;
		}

		let queryParams;

		if (query.where) {
			queryParams = _.isString(query.where) ? JSON.parse(query.where) : query.where;
		} else {
			queryParams = query;
		}

		for (let key in queryParams) {
			if (_.indexOf(QueryToSql.keywords, key) !== -1) {
				continue;
			}

			let compare = "";
			let columnName = "";
			let value;

			if (query[key] === "") {
				continue;
			}

			if (typeof queryParams[key] === "object") {
				compare = Object.keys(queryParams[key])[0];
			}

			if (compare !== "") {
				value = queryParams[key][compare];
			} else {
				value = queryParams[key];
			}

			QueryToSql.processCompare(table, key, compare, value, properties, sqlBuilder);

		}


		return sqlBuilder;
	}

	/**
	 *
	 * @param {string} key - the field key
	 * @param {string} compare - the comparitor, gt, >, < lt, !, != etc
	 * @param {varies} value - the string, array, number, etc
	 * @param {Object} properties - the properties of this model from a JSON schema
	 * @param {Object} sqlBuilder - the current knex sqlBuilder
	 */
	static processCompare(table, key, compare, value, properties, sqlBuilder) {

		let columnName;
		if (properties[key] && properties[key].columnName) {
			columnName = properties[key].columnName;
		} else {
			return;
		}

		switch (compare) {
			case "inside" :
			case "near" :
			case "radius" :
			case "poly" :
			case "geohash" :
			case "box" :
				//TODO integrate geo query functions
				break;
			case "gt" :
			case ">" :
				sqlBuilder.where(table + "." + columnName, ">", QueryToSql.processType(value, properties[key]));
				break;
			case "gte" :
			case ">=" :
				sqlBuilder.where(table + "." +columnName, ">=", QueryToSql.processType(value, properties[key]));
				break;
			case "lt" :
			case "<" :
				sqlBuilder.where(table + "." +columnName, "<", QueryToSql.processType(value, properties[key]));
				break;
			case "lte" :
			case "<=" :
				sqlBuilder.where(table + "." +columnName, "<=", QueryToSql.processType(value, properties[key]));
				break;
			case "in" :
				sqlBuilder.whereIn(table + "." +columnName, QueryToSql.processArrayType(value, properties[key]));
				break;
			case "nin" :
				sqlBuilder.whereNotIn(table + "." +columnName, QueryToSql.processArrayType(value, properties[key]));
				break;
			case "endsWith" :
				sqlBuilder.where(table + "." +columnName, QueryToSql.like, "%" + value); //todo postgres only
				break;
			case "startsWith" :
				sqlBuilder.where(table + "." +columnName, QueryToSql.like, value + "%"); //todo postgres only
				break;
			case "contains" :
				sqlBuilder.where(table + "." +columnName, QueryToSql.like, "%" + value + "%"); //todo postgres only
				break;
			case "==" :
			case "eq" :
				if (value === null) {
					sqlBuilder.whereNull(table + "." +columnName, QueryToSql.processType(value, properties[key]));
				} else if (_.isArray(value)) {
					sqlBuilder.whereIn(table + "." +columnName, QueryToSql.processArrayType(value, properties[key]));
				} else {
					sqlBuilder.whereNot(table + "." +columnName, QueryToSql.processType(value, properties[key]));
				}
				break;
			case "!" :
			case "!=" :
			case "ne" :
				if (value === null) {
					sqlBuilder.whereNotNull(table + "." +columnName, QueryToSql.processType(value, properties[key]));
				} else if (_.isArray(value)) {
					sqlBuilder.whereNotIn(table + "." +columnName, QueryToSql.processArrayType(value, properties[key]));
				} else {
					sqlBuilder.whereNot(table + "." +columnName, QueryToSql.processType(value, properties[key]));
				}
				break;
			case "or" :
				/**
				 * or : [
				 *  {field1: val1},
				 *  {field2 {">":val2}
			        * ]
				 */
				sqlBuilder.where(
					(builder) => {
						for (let i = 0; i < value.length; i++) {
							let innerCompare = "";
							let innerValue;
							let innerKey = Object.keys(value[i])[0];
							let innerColumnName;

							if (typeof value[i][innerKey] === "object") {
								innerCompare = Object.keys(value[i][innerKey])[0];
							}

							if (innerCompare !== "") {
								innerValue = value[i][innerKey][compare];
							} else {
								innerValue = value[i];
							}

							//compare, columnName, key, value, properties, sqlBuilder
							QueryToSql.processCompare(innerKey, innerCompare, innerValue, properties, builder)
						}
					}
				);
				break;
			default :
				if (value === null) {
					sqlBuilder.whereNull(table + "." +columnName, QueryToSql.processType(value, properties[key]));
				} else if (_.isArray(value)) {
					sqlBuilder.whereIn(table + "." +columnName, QueryToSql.processArrayType(value, properties[key]));
				} else {
					sqlBuilder.where(table + "." +columnName, QueryToSql.processType(value, properties[key]));
				}
		}
	}


	/**
	 * decode funny query string values
	 * @param query
	 * @returns {string}
	 */
	static decodeQuery(query) {
		return decodeURI(query).split("/").join("\/");
	}

	/**
	 * Incoming values are pretty much all going to be strings, so let's parse that out to be come correct types
	 * @param value
	 * @param {Object} property - a single json schema property
	 * @returns {*}
	 */
	static processType(value, property) {
		switch (property.type) {
			case "object" :
				try {
					return _.isObject(value) ? JSON.stringify(value) : value;
				} catch (e) {
					return null;
				}
				break;
			case "number" :
				if (!_.isNumber(value)) {
					if (property.type && property.type === "integer") {
						value = parseInt(value);
						if (!isNaN(value)) {
							return value;
						}
					} else {
						value = parseFloat(value);
						if (!isNaN(value)) {
							return value;
						}
					}
					return null;
				}
				return value;
				break;
			case "boolean" :
				return value === "1" || value === "true";
				break;
			case "string" :
				if (property.format) {
					switch (property.format) {
						case "date-time" :
							var m = moment(value);
							if (m) {
								return m.format("YYYY-MM-DD HH:mm:ss")
							}
							return null;
						default :
							return QueryToSql.decodeQuery(value).trim();
					}
				} else {
					return _.isString(value) ? value.trim() : value;
				}
				break;
		}
		return value;
	}

	/**
	 * Where in, nin conditions are present, the options need to be parsed to the correct data-type
	 * @param {string|array} list - a string is array of values. string should be comma separated
	 * @param {Object} property - a singular item in json schema
	 * @returns {Array}
	 */
	static processArrayType(list, property) {
		if (!_.isArray(list)) {
			list = list.split(",");
		}
		var valueList = [];
		list.forEach(
			function (item) {
				let v = QueryToSql.processType(item, property);
				if (v) {
					valueList.push(v);
				}
			}
		);

		return valueList;
	}
}
