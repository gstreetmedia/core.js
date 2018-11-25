const ejs = require("ejs");
const fs = require("fs");
const moment = require("moment");
const _ = require("lodash");

const selectTemplate = ejs.compile(fs.readFileSync("./src/views/elements/form/select.ejs", 'utf-8'));
const radioTemplate = ejs.compile(fs.readFileSync("./src/views/elements/form/radio.ejs", 'utf-8'));
const checkboxTemplate = ejs.compile(fs.readFileSync("./src/views/elements/form/checkbox.ejs", 'utf-8'));
const textAreaTemplate = ejs.compile(fs.readFileSync("./src/views/elements/form/textArea.ejs", 'utf-8'));
const inputTemplate = ejs.compile(fs.readFileSync("./src/views/elements/form/input.ejs", 'utf-8'));

function findStringType(attribute, attr) {

	if (attribute.enum) {
		attr.options = attribute.enum;
		attr.type = attribute.enum.length > 3 ? "select" : "radio";
		return;
	}

	if (attribute.maxLength > 255) {
		attr.type = "textArea";
		return;
	}

	if (attribute.format) {
		switch (attribute.format) {
			case "email" :
				attr.type = "email";
				return;
			case "uuid" :
				attr['data-type'] = 'uuid';
				attr['max'] = 36;
				return;
			case "url" :
				attr.type = "url";
				return;
			case "date" :
				attr.type = "date";
				return;
			case "date-time" :
				attr.type = "datetime-local";
				return;
			case "phone" :
				attr.type = "tel";
				return;
			case "enum" :
				break;
			case "maxLength" :

		}
	}

	if (attr.maxLength > 64) {
		attr.type = "textArea";
		return;
	}

}


function findRefType(attribute, attr) {
	let columnType = attribute.columnType.split(" ")[0];
	switch (columnType) {
		case "date" :
			attr.type = "date";
			break;
		case "timestamp" :
			attr.type = "datetime-local";
			break;
		case "time" :
			attr.type = "time";
			break;
		case "jsonb" :
		case "json" :
			attr.dataType = 'json';
			break;
		case "int" :
			attr.dataType = 'integer';
			break;
		case "decimal" :
			attr.dataType = 'float';
			break;
		case "text" :
			attr.type = "textArea";
			break;
		case "varchar" :
			attr.dataType = 'string';
			break;

	}
}

function createElement(attr) {


	switch (attr.type) {
		case "select" :
			return selectTemplate(attr);
		case "radio" :
			return radioTemplate(attr);
		case "checkbox" :
			return checkboxTemplate(attr);
		case "textArea" :
			return textAreaTemplate(attr);
		default :
			return inputTemplate(attr);
	}
}

module.exports = function (model, key, value) {
	let attribute = model.properties[key];

	if (!attribute) {
		console.log("Cannot find attribute for key => " + key);
		return null;
	}

	let attr = {
		type: "text",
		class: "",
		required: "",
		value: value,
		dataType: "",
		maxlength: attribute.maxLength || null,
		minlength: attribute.minLength || null,
		max: attribute.maxLength || null,
		min: attribute.minLength || null,
		name: key,
		id: key + "Field",
		options: null,
		disabled: false
	};

	if (_.indexOf(model.schema.required, key) !== -1) {
		attr.required = "required";
	}

	//console.log(model.schema.required);

	switch (attribute.type) {
		case "string" :
			findStringType(attribute, attr);
			break;
		case "number" :
			attr.type = "number";
			break;
		case "object" :
			attr.value = JSON.stringify(value);
			attr.dataType = 'json';
			attr.type = "textArea"
			break;
		case "boolean" :
			attr.type = "radio";
			attr.options = ['true', 'false'];
			break;

	}

	if (attr.type === "date" && typeof attr.value === "object") {
		//console.log("format value");
		attr.value = moment(attr.value).format("YYYY-MM-DD");
		//console.log(attr.value);
	} else if (attr.type === "datetime-local" && typeof attr.value === "object") {
		//console.log("format value");
		attr.value = moment(attr.value).format("YYYY-MM-DDTHH:mm:ss");
		//console.log(attr.value);
	}

	if (key === model.primaryKey) {
		attr.disabled = true;
	}

	if (key === "password") {
		attr.value = '';
		attr.required = false;
	}

	return createElement(attr);
};