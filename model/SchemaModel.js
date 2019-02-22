const ModelBase = require('./ModelBase');
const _ = require('lodash');
const schema = require('../schema/schemas-schema');
const validation = require('../schema/validation/schemas-validation');
const fields = require('../schema/fields/schemas-fields');
const cache = require("../helper/cache-manager");
const md5 = require("md5");
const connectionStringParser = require("connection-string");
let schemaModel;

module.exports = class SchemaModel extends ModelBase {

	constructor(req) {
		super(schema, validation, fields, req);
		this.tableExists = null;
	}

	get connectionString() {
		return process.env.DEFAULT_DB;
	}

	static get schema() {
		return schema;
	}

	static get validation() {
		return validation;
	}

	static get fields() {
		return fields;
	}

	async index(key, value) {
		return await super.index(key, value);
	}

	async create(data) {
		return await super.create(data);
	}

	async read(id, query) {
		return await super.read(id, query);
	}

	async update(id, data, query) {
		return await super.update(id, data, query);
	}

	async query(query) {
		return await super.query(query);
	}

	async destroy(id) {
		return await super.destroy(id);
	}

	async loadSchemas(connectionStrings) {
		if (!_.isArray(connectionStrings)) {
			connectionStrings = [connectionStrings];
		}

		let strings = [];

		connectionStrings.forEach(
			function (item) {
				let cs = connectionStringParser(item);
				cs.connectionString = item;
				strings.push(cs);
				//console.log();
			}
		);

		let results = await this.find({where: {dataSource: {"!=": null}}});
		//console.log(results);

		let count = 0;
		results.forEach(
			function (item) {
				strings.forEach(
					function (cs) {

						if (cs.path[0] === item.dataSource) {
							global.schemaCache = global.schemaCache || {};
							global.schemaCache[item.tableName] = item;
							count++;
						}
					}
				)
			}
		);
		console.log("Loaded " + count + " schemas");
	}

	async hasTable() {
		if (this.tableExists === null) {
			let result = await this.execute(
				'SELECT EXISTS (\n' +
				'    SELECT 1\n' +
				'    FROM   information_schema.tables\n' +
				'    WHERE  table_schema = \'public\'\n' +
				'           AND    table_name = \'_schemas\'\n' +
				');'
			)

			this.tableExists = result[0].exists;

			//console.log("this.tableExists => " + this.tableExists);
		}
		return this.tableExists;
	}

	async get(tableName, fromCache) {

		if (fromCache !== false) {
			let result = await cache.get("schema_" + tableName);
			if (result) {
				return result;
			}
		}

		let result = await this.find(
			{
				where: {
					tableName: tableName
				}
			}
		);

		if (result.length === 1) {
			await cache.get("schema_" + tableName, result[0]);
			return result[0];
		}
		return null;

	}

	async set(tableName, data) {
		let table = await this.get(tableName, false);
		if (table) {
			return await this.update(table.id, data);
		} else {
			table = this.create(data);
			if (table.error) {
				console.log("schema set error " + table.error);
			} else {
				console.log(tableName + " created");
				await cache.set("schema_" + tableName, table);
			}
			return table;
		}
	}

	async createTable() {
		await this.execute(
			'drop table _schemas;\n' +
			'create table "_schemas"\n' +
			'(\n' +
			'  id          uuid        not null\n' +
			'    constraint schemas_pkey\n' +
			'    primary key,\n' +
			'  data_source varchar(64),\n' +
			'  title       varchar(255),\n' +
			'  table_name  varchar(64) not null,\n' +
			'  primary_key varchar(64) default \'id\' :: character varying,\n' +
			'  properties  jsonb       not null,\n' +
			'  required    varchar(64) [],\n' +
			'  read_only   varchar(64) [],\n' +
			'  created_at  timestamp   default now(),\n' +
			'  updated_at  timestamp   default now()\n' +
			');\n' +
			'\n' +
			'create unique index schemas_id_uindex\n' +
			'  on "_schemas" (id);\n' +
			'\n' +
			'create unique index schemas_table_name_uindex\n' +
			'  on "_schemas" (table_name);\n' +
			'\n'
		)
	}

}