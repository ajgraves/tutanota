/**
 * @fileOverview This file is used by the api class generator in another repo
 * but is checked in here so that it's updated in lockstep with rust code that expects it.
 */

import { AssociationType, Type, ValueType } from "../src/common/api/common/EntityConstants.js"
import { capitalizeFirstLetter } from "@tutao/tutanota-utils"

/**
 * @param models {object}
 * @param typeModel {import("../src/common/api/common/EntityTypes.js").TypeModel}
 * @param modelName {string}
 * @return {string}
 */
export function generateRustType(models, typeModel, modelName) {
	let typeName = mapTypeName(typeModel.name, modelName)
	let typeId = typeModel.id
	let buf = `#[derive(uniffi::Record, Clone, Serialize, Deserialize)]
#[cfg_attr(any(test, feature = "testing"), derive(PartialEq, Debug))]
pub struct ${typeName} {\n`
	for (let [valueId, valueProperties] of Object.entries(typeModel.values)) {
		const valueName = valueProperties.name
		const rustType = rustValueType(valueName, typeModel, valueProperties)
		buf += `\t#[serde(rename = "${valueId}")]\n`
		if (valueName === "type") {
			buf += `\tpub r#type: ${rustType},\n`
		} else if (valueProperties.type === "Bytes") {
			buf += `\t#[serde(with = "serde_bytes")]\n`
			buf += `\tpub ${valueName}: ${rustType},\n`
		} else {
			buf += `\tpub ${valueName}: ${rustType},\n`
		}
	}

	for (let [associationId, associationProperties] of Object.entries(typeModel.associations)) {
		const associationName = associationProperties.name
		const innerRustType = rustAssociationType(associationProperties, modelName, models)
		let rustType
		switch (associationProperties.cardinality) {
			case "ZeroOrOne":
				rustType = `Option<${innerRustType}>`
				break
			case "Any":
				rustType = `Vec<${innerRustType}>`
				break
			case "One":
				rustType = innerRustType
				break
		}

		buf += `\t#[serde(rename = "${associationId}")]\n`
		if (associationName === "type") {
			buf += `\tpub r#type: ${rustType},\n`
		} else {
			buf += `\tpub ${associationName}: ${rustType},\n`
		}
	}

	// aggregates do not say whether they are encrypted or not. For some reason!
	if (typeModel.encrypted || Object.values(typeModel.values).some((v) => v.encrypted)) {
		buf += `
	#[serde(default)]
	pub _errors: Errors,
	#[serde(default)]
	pub _finalIvs: HashMap<String, Option<FinalIv>>,
`
	}

	buf += "}"
	buf += `

impl Entity for ${typeName} {
	fn type_ref() -> TypeRef {
		TypeRef {
			app: AppName::${capitalizeFirstLetter(modelName)},
			type_id: TypeId::from(${typeId}),
		}
	}
}`

	return buf
}

export function generateRustServiceDefinition(appName, appVersion, services) {
	let imports = new Set([
		"#![allow(unused_imports, dead_code, unused_variables)]",
		"use crate::ApiCallError;",
		"use crate::entities::Entity;",
		"use crate::services::{PostService, GetService, PutService, DeleteService, Service, Executor, ExtraServiceParams};",
		"use crate::bindings::rest_client::HttpMethod;",
		"use crate::services::hidden::Nothing;",
	])
	const code = services
		.map((s) => {
			let serviceDefinition = `
pub struct ${s.name};

crate::service_impl!(declare, ${s.name}, "${appName}/${s.name.toLowerCase()}", ${appVersion});
`

			function getTypeRef(dataType) {
				if (dataType) {
					return `Some(${dataType}::type_ref())`
				} else {
					return "None"
				}
			}

			function addImports(appName, input, output) {
				if (input) {
					imports.add(`use crate::entities::generated::${appName}::${input};`)
				}
				if (output) {
					imports.add(`use crate::entities::generated::${appName}::${output};`)
				}
			}

			function makeImpl(name, input, output) {
				addImports(appName, input, output)
				return `crate::service_impl!(${name}, ${s.name}, ${input ?? "()"}, ${output ?? "()"});\n`
			}

			if (s.bodyTypes.POST_IN || s.bodyTypes.POST_OUT) {
				serviceDefinition += makeImpl("POST", s.bodyTypes.POST_IN, s.bodyTypes.POST_OUT)
			}

			if (s.bodyTypes.GET_IN || s.bodyTypes.GET_OUT) {
				serviceDefinition += makeImpl("GET", s.bodyTypes.GET_IN, s.bodyTypes.GET_OUT)
			}

			if (s.bodyTypes.PUT_IN || s.bodyTypes.PUT_OUT) {
				serviceDefinition += makeImpl("PUT", s.bodyTypes.PUT_IN, s.bodyTypes.PUT_OUT)
			}

			if (s.bodyTypes.DELETE_IN || s.bodyTypes.DELETE_OUT) {
				serviceDefinition += makeImpl("DELETE", s.bodyTypes.DELETE_IN, s.bodyTypes.DELETE_OUT)
			}

			return serviceDefinition
		})
		.join("\n")
	return "// @generated\n" + Array.from(imports).join("\n") + code
}

/**
 * @param types {string[]}
 * @return {string}
 */
export function combineRustTypes(types) {
	if (types.length === 0) return "\n"
	return `// @generated
#![allow(non_snake_case, unused_imports)]
use super::super::*;
use crate::*;
use serde::{Deserialize, Serialize};

${types.join("\n\n")}
`
}

/**
 * @param name {string}
 * @param modelName {string}
 * @return {string}
 */
function mapTypeName(name, modelName) {
	if (name === "File" && modelName === "tutanota") return "TutanotaFile"
	if (name === "Exception" && modelName === "sys") return "SysException"
	return name
}

/**
 * @param valueName {string}
 * @param typeModel {import("../src/common/api/common/EntityTypes.js").TypeModel}
 * @param value {import("../src/common/api/common/EntityTypes.js").ModelValue}
 * @return {string}
 */
function rustValueType(valueName, typeModel, value) {
	const ValueToRustTypes = Object.freeze({
		String: "String",
		Number: "i64",
		Bytes: "Vec<u8>",
		Date: "DateTime",
		Boolean: "bool",
		GeneratedId: "GeneratedId",
		CustomId: "CustomId",
		CompressedString: "String",
	})

	let innerType
	if (valueName === "_id" && (typeModel.type === Type.ListElement || typeModel.type === Type.BlobElement)) {
		if (value.type === ValueType.CustomId) {
			innerType = "Option<IdTupleCustom>"
		} else {
			innerType = "Option<IdTupleGenerated>"
		}
	} else if (valueName === "_id") {
		innerType = `Option<${ValueToRustTypes[value.type]}>`
	} else {
		innerType = ValueToRustTypes[value.type]
	}
	if (value.cardinality === "ZeroOrOne") {
		return `Option<${innerType}>`
	} else {
		return innerType
	}
}

/**
 * @param association {import("../src/common/api/common/EntityTypes.js").ModelAssociation}
 * @return {string}
 */
function rustAssociationType(association, modelName, models) {
	if (association.type === AssociationType.Aggregation) {
		const dependentApp = association.dependency ?? modelName
		const dependentType = models[dependentApp].types[association.refTypeId].name
		const refTypeName = mapTypeName(dependentType, dependentApp)

		if (association.dependency) {
			return `super::${association.dependency}::${refTypeName}`
		} else {
			return refTypeName
		}
	} else if (association.type === AssociationType.ListElementAssociationCustom) {
		return "IdTupleCustom"
	} else if (association.type === AssociationType.ListElementAssociationGenerated || association.type === AssociationType.BlobElementAssociation) {
		return "IdTupleGenerated" // blob ids are also always generated
	} else {
		return "GeneratedId"
	}
}
