use crate::bindings::rest_client::{
	encode_query_params, HttpMethod, RestClient, RestClientOptions, RestResponse,
};
#[cfg_attr(test, mockall_double::double)]
use crate::crypto::crypto_facade::CryptoFacade;
use crate::entities::entity_facade::EntityFacade;
use crate::entities::Entity;
use crate::instance_mapper::InstanceMapper;
use crate::json_element::RawEntity;
use crate::json_serializer::JsonSerializer;
use crate::metamodel::TypeModel;
use crate::rest_error::HttpError;
use crate::services::hidden::Executor;
use crate::services::{
	DeleteService, ExtraServiceParams, GetService, PostService, PutService, Service,
};
use crate::type_model_provider::TypeModelProvider;
use crate::{ApiCallError, HeadersProvider};
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::borrow::Borrow;
use std::ops::Deref;
use std::sync::Arc;

/// wrapper around a service executor that is guaranteed to have the ability
/// to resolve session keys (and therefore to call services returning encrypted instances)
pub struct ResolvingServiceExecutor(ServiceExecutor);

impl Deref for ResolvingServiceExecutor {
	type Target = ServiceExecutor;

	fn deref(&self) -> &Self::Target {
		&self.0
	}
}

impl ResolvingServiceExecutor {
	#[must_use]
	pub fn new(
		auth_headers_provider: Arc<HeadersProvider>,
		crypto_facade: Arc<CryptoFacade>,
		entity_facade: Arc<dyn EntityFacade>,
		instance_mapper: Arc<InstanceMapper>,
		json_serializer: Arc<JsonSerializer>,
		rest_client: Arc<dyn RestClient>,
		type_model_provider: Arc<TypeModelProvider>,
		base_url: String,
	) -> Self {
		Self(ServiceExecutor::new(
			auth_headers_provider,
			Some(crypto_facade),
			entity_facade,
			instance_mapper,
			json_serializer,
			rest_client,
			type_model_provider,
			base_url,
		))
	}
}

pub struct ServiceExecutor {
	auth_headers_provider: Arc<HeadersProvider>,
	crypto_facade: Option<Arc<CryptoFacade>>,
	entity_facade: Arc<dyn EntityFacade>,
	instance_mapper: Arc<InstanceMapper>,
	json_serializer: Arc<JsonSerializer>,
	rest_client: Arc<dyn RestClient>,
	type_model_provider: Arc<TypeModelProvider>,
	base_url: String,
}

#[cfg_attr(test, mockall::automock)]
impl ServiceExecutor {
	#[must_use]
	pub fn new(
		auth_headers_provider: Arc<HeadersProvider>,
		crypto_facade: Option<Arc<CryptoFacade>>,
		entity_facade: Arc<dyn EntityFacade>,
		instance_mapper: Arc<InstanceMapper>,
		json_serializer: Arc<JsonSerializer>,
		rest_client: Arc<dyn RestClient>,
		type_model_provider: Arc<TypeModelProvider>,
		base_url: String,
	) -> Self {
		Self {
			auth_headers_provider,
			crypto_facade,
			entity_facade,
			instance_mapper,
			json_serializer,
			rest_client,
			type_model_provider,
			base_url,
		}
	}

	pub async fn get<S>(
		&self,
		data: S::Input,
		params: ExtraServiceParams,
	) -> Result<S::Output, ApiCallError>
	where
		S: GetService,
	{
		S::GET(self, data, params).await
	}

	pub async fn post<S>(
		&self,
		data: S::Input,
		params: ExtraServiceParams,
	) -> Result<S::Output, ApiCallError>
	where
		S: PostService,
	{
		S::POST(self, data, params).await
	}

	pub async fn put<S>(
		&self,
		data: S::Input,
		params: ExtraServiceParams,
	) -> Result<S::Output, ApiCallError>
	where
		S: PutService,
	{
		S::PUT(self, data, params).await
	}

	pub async fn delete<S>(
		&self,
		data: S::Input,
		params: ExtraServiceParams,
	) -> Result<S::Output, ApiCallError>
	where
		S: DeleteService,
	{
		S::DELETE(self, data, params).await
	}

	async fn ensure_latest_server_model(
		&self,
		response: &RestResponse,
	) -> Result<(), ApiCallError> {
		let current_model_hash = response
			.headers
			.get("app-types-hash")
			.map(|a| a.as_str())
			// if server did not put hash in response header,
			// always fetch application types again just to be safe
			.unwrap_or("non-existant-hash");

		self.type_model_provider
			.clone()
			.ensure_latest_server_model(current_model_hash)
			.await
	}
}

// Needed because ResolvingServiceExecutor relies on Deref and doesn't have ServiceExecutor
// functions on its own.
#[cfg(test)]
mockall::mock! {
	pub ResolvingServiceExecutor {
		pub fn new(
			auth_headers_provider: Arc<HeadersProvider>,
			crypto_facade: Arc<CryptoFacade>,
			entity_facade: Arc<dyn EntityFacade>,
			instance_mapper: Arc<InstanceMapper>,
			json_serializer: Arc<JsonSerializer>,
			rest_client: Arc<dyn RestClient>,
			type_model_provider: Arc<TypeModelProvider>,
			base_url: String,
		) -> Self;

		pub async fn get<S>(
			&self,
			data: S::Input,
			params: ExtraServiceParams,
		) -> Result<S::Output, ApiCallError>
		where S: GetService;

		pub async fn post<S>(
			&self,
			data: S::Input,
			params: ExtraServiceParams,
		) -> Result<S::Output, ApiCallError>
		where S: PostService;

		pub async fn put<S>(
			&self,
			data: S::Input,
			params: ExtraServiceParams,
		) -> Result<S::Output, ApiCallError>
		where S: PutService;

		pub async fn delete<S>(
			&self,
			data: S::Input,
			params: ExtraServiceParams,
		) -> Result<S::Output, ApiCallError>
		where S: DeleteService;
	}
}

#[async_trait::async_trait]
impl Executor for ServiceExecutor {
	async fn do_request<S, I>(
		&self,
		data: Option<I>,
		method: HttpMethod,
		extra_service_params: ExtraServiceParams,
	) -> Result<Option<Vec<u8>>, ApiCallError>
	where
		S: Service,
		I: Entity + Serialize + Send,
	{
		// the url is mutable as we might later need to extend it in case of GET reuqests with payload data
		let mut url = format!(
			"{}/rest/{}",
			if let Some(url) = extra_service_params.base_url {
				url.clone()
			} else {
				self.base_url.clone()
			},
			S::PATH,
		);
		let model_version: u64 = S::VERSION;
		let mut query_params = extra_service_params.query_params.unwrap_or_default();

		let parsed_input_data: Option<RawEntity> = if let Some(input_entity) = data {
			let parsed_entity = self
				.instance_mapper
				.serialize_entity(input_entity)
				.map_err(|e| {
					ApiCallError::internal_with_err(e, "failed to convert to ParsedEntity")
				})?;
			let input_type_ref = I::type_ref();
			let type_model = self
				.type_model_provider
				.resolve_client_type_ref(&input_type_ref)
				.ok_or(ApiCallError::internal(format!(
					"type {:?} does not exist",
					input_type_ref
				)))?;

			let encrypted_parsed_entity = if type_model.is_encrypted() {
				match extra_service_params.session_key {
					Some(ref sk) => {
						self.entity_facade
							.encrypt_and_map(type_model, &parsed_entity, sk)?
					},

					None => Err(ApiCallError::InternalSdkError {
						error_message: format!(
							"Encrypting {}/{} requires a session key!",
							type_model.app, type_model.name
						),
					})?,
				}
			} else {
				parsed_entity
			};

			Some(
				self.json_serializer
					.serialize(&I::type_ref(), encrypted_parsed_entity)?,
			)
		} else {
			None
		};

		let body = match parsed_input_data {
			None => None,
			Some(input) => {
				//we cannot send a body with GET so we send as url parameters
				if method == HttpMethod::GET {
					query_params.insert(
						"_body".to_string(),
						serde_json::to_string(&input).map_err(|e| {
							ApiCallError::internal_with_err(
								e,
								"failed to serialize input to string",
							)
						})?,
					);
					None
				} else {
					Some(serde_json::to_vec::<RawEntity>(&input).map_err(|e| {
						ApiCallError::internal_with_err(e, "failed to serialize input to string")
					})?)
				}
			},
		};

		let mut headers = self.auth_headers_provider.provide_headers(model_version);
		if let Some(extra_headers) = extra_service_params.extra_headers {
			headers.extend(extra_headers);
		}
		if body.is_some() {
			headers.insert("Content-Type".to_owned(), "application/json".to_owned());
		}
		url = format!("{}{}", url, encode_query_params(&query_params));

		let response = self
			.rest_client
			.request_binary(
				url,
				method,
				RestClientOptions {
					body,
					headers,
					suspension_behavior: extra_service_params.suspension_behavior,
				},
			)
			.await?;

		self.ensure_latest_server_model(&response).await?;

		let precondition = response.headers.get("precondition");
		match response.status {
			200 | 201 => Ok(response.body),
			_ => Err(ApiCallError::ServerResponseError {
				source: HttpError::from_http_response(response.status, precondition)?,
			}),
		}
	}

	async fn handle_response<OutputType>(
		&self,
		body: Option<Vec<u8>>,
	) -> Result<OutputType, ApiCallError>
	where
		OutputType: Entity + DeserializeOwned,
	{
		let response_bytes = body.expect("no body");
		let response_entity = serde_json::from_slice::<RawEntity>(response_bytes.as_slice())
			.map_err(|e| ApiCallError::internal_with_err(e, "Failed to serialize instance"))?;
		let output_type_ref = &OutputType::type_ref();
		let parsed_entity = self
			.json_serializer
			.parse(output_type_ref, response_entity)?;
		let type_model = self
			.type_model_provider
			.resolve_server_type_ref(output_type_ref)
			.expect("invalid type ref!");
		let type_model: &TypeModel = type_model.borrow();

		if type_model.marked_encrypted() {
			let session_key = self
				.crypto_facade
				.as_ref()
				.ok_or_else(|| {
					ApiCallError::internal(format!(
						"got encrypted response, but cannot resolve session keys yet: {}",
						type_model.name,
					))
				})?
				.resolve_session_key(&parsed_entity, type_model)
				.await
				.map_err(|error| {
					ApiCallError::internal(format!(
						"Failed to resolve session key for service response '{}'; {}",
						type_model.name, error
					))
				})?
				// `resolve_session_key()` only returns none if the entity is unencrypted, so
				// no need to handle it
				.expect("encrypted entity should resolve a session key");

			let decrypted_entity =
				self.entity_facade
					.decrypt_and_map(type_model, parsed_entity, session_key)?;
			let typed_entity = self
				.instance_mapper
				.parse_entity::<OutputType>(decrypted_entity)
				.map_err(|e| {
					ApiCallError::internal_with_err(
						e,
						"Failed to parse encrypted entity into proper types",
					)
				})?;
			Ok(typed_entity)
		} else {
			let typed_entity = self
				.instance_mapper
				.parse_entity::<OutputType>(parsed_entity)
				.map_err(|error| {
					ApiCallError::internal_with_err(
						error,
						"Failed to parse unencrypted entity into proper types",
					)
				})?;
			Ok(typed_entity)
		}
	}
}

#[cfg(test)]
mod tests {
	use crate::bindings::rest_client::{HttpMethod, MockRestClient, RestResponse};
	#[mockall_double::double]
	use crate::crypto::crypto_facade::CryptoFacade;
	use crate::crypto::crypto_facade::ResolvedSessionKey;
	use crate::crypto::key::GenericAesKey;
	use crate::crypto::AES_256_KEY_SIZE;
	use crate::date::DateTime;
	use crate::element_value::ElementValue;
	use crate::entities::entity_facade::MockEntityFacade;
	use crate::entities::Entity;
	use crate::instance_mapper::InstanceMapper;
	use crate::json_element::RawEntity;
	use crate::json_serializer::JsonSerializer;
	use crate::metamodel::AppName;
	use crate::services::service_executor::ResolvingServiceExecutor;
	use crate::services::ExtraServiceParams;
	use crate::util::test_utils::*;
	use crate::{HeadersProvider, CLIENT_VERSION};
	use base64::prelude::BASE64_STANDARD;
	use base64::Engine;
	use std::collections::HashMap;
	use std::sync::Arc;

	#[tokio::test]
	pub async fn post_should_map_unencrypted_data_and_response() {
		let hello_input_data = HelloUnEncInput {
			message: "Something".to_string(),
			_errors: Default::default(),
		};
		let executor = maps_unencrypted_data_and_response(HttpMethod::POST);
		let result = executor
			.post::<HelloUnEncryptedService>(hello_input_data, ExtraServiceParams::default())
			.await;

		assert_eq!(
			Ok(HelloUnEncOutput {
				timestamp: DateTime::from_millis(3000),
				answer: "Response to some request".to_string(),
			}),
			result
		);
	}

	#[tokio::test]
	pub async fn put_should_map_unencrypted_data_and_response() {
		let hello_input_data = HelloUnEncInput {
			message: "Something".to_string(),
			_errors: Default::default(),
		};
		let executor = maps_unencrypted_data_and_response(HttpMethod::PUT);
		let result = executor
			.put::<HelloUnEncryptedService>(hello_input_data, ExtraServiceParams::default())
			.await;

		assert_eq!(
			Ok(HelloUnEncOutput {
				timestamp: DateTime::from_millis(3000),
				answer: "Response to some request".to_string(),
			}),
			result
		);
	}

	#[tokio::test]
	pub async fn get_should_map_unencrypted_data_and_response() {
		let hello_input_data = HelloUnEncInput {
			message: "Something".to_string(),
			_errors: Default::default(),
		};
		let executor = maps_unencrypted_data_and_response(HttpMethod::GET);
		let result = executor
			.get::<HelloUnEncryptedService>(hello_input_data, ExtraServiceParams::default())
			.await;

		assert_eq!(
			Ok(HelloUnEncOutput {
				timestamp: DateTime::from_millis(3000),
				answer: "Response to some request".to_string(),
			}),
			result
		);
	}

	#[tokio::test]
	pub async fn delete_should_map_unencrypted_data_and_response() {
		let hello_input_data = HelloUnEncInput {
			message: "Something".to_string(),
			_errors: Default::default(),
		};
		let executor = maps_unencrypted_data_and_response(HttpMethod::DELETE);
		let result = executor
			.delete::<HelloUnEncryptedService>(hello_input_data, ExtraServiceParams::default())
			.await;

		assert_eq!(
			Ok(HelloUnEncOutput {
				timestamp: DateTime::from_millis(3000),
				answer: "Response to some request".to_string(),
			}),
			result
		);
	}

	#[tokio::test]
	pub async fn post_should_decrypt_map_encrypted_data_and_response() {
		let session_key =
			GenericAesKey::from_bytes(&rand::random::<[u8; AES_256_KEY_SIZE]>()).unwrap();
		let executor = maps_encrypted_data_and_response_data(HttpMethod::POST, session_key.clone());

		let params = ExtraServiceParams {
			session_key: Some(session_key.clone()),
			..ExtraServiceParams::default()
		};
		let input_entity = HelloEncInput {
			message: "my encrypted request".to_string(),
		};

		let result = executor
			.post::<HelloEncryptedService>(input_entity, params)
			.await;
		assert_eq!(
			Ok(HelloEncOutput {
				answer: "my secret response".to_string(),
				timestamp: DateTime::from_millis(3000),
				_finalIvs: HashMap::new()
			}),
			result
		);
	}

	#[tokio::test]
	pub async fn put_should_decrypt_map_encrypted_data_and_response() {
		let session_key =
			GenericAesKey::from_bytes(&rand::random::<[u8; AES_256_KEY_SIZE]>()).unwrap();
		let executor = maps_encrypted_data_and_response_data(HttpMethod::PUT, session_key.clone());

		let params = ExtraServiceParams {
			session_key: Some(session_key.clone()),
			..ExtraServiceParams::default()
		};
		let input_entity = HelloEncInput {
			message: "my encrypted request".to_string(),
		};

		let result = executor
			.put::<HelloEncryptedService>(input_entity, params)
			.await;
		assert_eq!(
			Ok(HelloEncOutput {
				answer: "my secret response".to_string(),
				timestamp: DateTime::from_millis(3000),
				_finalIvs: HashMap::new()
			}),
			result
		);
	}

	#[tokio::test]
	pub async fn get_should_decrypt_map_encrypted_data_and_response() {
		let session_key =
			GenericAesKey::from_bytes(&rand::random::<[u8; AES_256_KEY_SIZE]>()).unwrap();
		let executor = maps_encrypted_data_and_response_data(HttpMethod::GET, session_key.clone());

		let params = ExtraServiceParams {
			session_key: Some(session_key.clone()),
			..ExtraServiceParams::default()
		};
		let input_entity = HelloEncInput {
			message: "my encrypted request".to_string(),
		};

		let result = executor
			.get::<HelloEncryptedService>(input_entity, params)
			.await;
		assert_eq!(
			Ok(HelloEncOutput {
				answer: "my secret response".to_string(),
				timestamp: DateTime::from_millis(3000),
				_finalIvs: HashMap::new()
			}),
			result
		);
	}

	#[tokio::test]
	pub async fn delete_should_decrypt_map_encrypted_data_and_response() {
		let session_key =
			GenericAesKey::from_bytes(&rand::random::<[u8; AES_256_KEY_SIZE]>()).unwrap();
		let executor =
			maps_encrypted_data_and_response_data(HttpMethod::DELETE, session_key.clone());

		let params = ExtraServiceParams {
			session_key: Some(session_key.clone()),
			..ExtraServiceParams::default()
		};
		let input_entity = HelloEncInput {
			message: "my encrypted request".to_string(),
		};

		let result = executor
			.delete::<HelloEncryptedService>(input_entity, params)
			.await;
		assert_eq!(
			Ok(HelloEncOutput {
				answer: "my secret response".to_string(),
				timestamp: DateTime::from_millis(3000),
				_finalIvs: HashMap::new()
			}),
			result
		);
	}

	fn setup() -> ResolvingServiceExecutor {
		let type_model_provider = Arc::new(mock_type_model_provider());

		let crypto_facade = Arc::new(CryptoFacade::default());
		let entity_facade = Arc::new(MockEntityFacade::default());
		let auth_headers_provider =
			Arc::new(HeadersProvider::new(Some("access_token".to_string())));
		let instance_mapper = Arc::new(InstanceMapper::new(type_model_provider.clone()));
		let json_serializer = Arc::new(JsonSerializer::new(type_model_provider.clone()));
		let rest_client = Arc::new(MockRestClient::new());

		ResolvingServiceExecutor::new(
			auth_headers_provider,
			crypto_facade,
			entity_facade,
			instance_mapper,
			json_serializer,
			rest_client,
			type_model_provider.clone(),
			"http://api.tuta.com".to_string(),
		)
	}

	fn maps_unencrypted_data_and_response(http_method: HttpMethod) -> ResolvingServiceExecutor {
		let executor = setup();
		let rest_client;
		let entity_facade;
		unsafe {
			rest_client = Arc::as_ptr(&executor.rest_client)
				.cast::<MockRestClient>()
				.cast_mut()
				.as_mut()
				.unwrap();
			entity_facade = Arc::as_ptr(&executor.entity_facade)
				.cast::<MockEntityFacade>()
				.cast_mut()
				.as_mut()
				.unwrap();
		}

		entity_facade.expect_encrypt_and_map().never();
		rest_client
            .expect_request_binary()
            .return_once(move |url, method, opts| {
                if method == HttpMethod::GET {
                    assert_eq!(
                        "http://api.tuta.com/rest/test/unencrypted-hello?_body=%7B%22149%22%3A%22Something%22%7D",
                        url.as_str()
                    );
                    assert_eq!(None, opts.body);
                } else {
                    assert_eq!(
                        "http://api.tuta.com/rest/test/unencrypted-hello",
                        url.as_str()
                    );
                    let expected_body =
                        serde_json::from_str::<RawEntity>(r#"{"149":"Something"}"#).unwrap();
                    let body =
                        serde_json::from_slice::<RawEntity>(opts.body.unwrap().as_slice()).unwrap();
                    assert_eq!(expected_body, body);
                }

                assert_eq!(http_method, method);

                let mut headers = vec![
                    ("v", APP_VERSION_STR),
                    ("accessToken", "access_token"),
                    ("cv", CLIENT_VERSION),
                ];
                if method != HttpMethod::GET {
                    headers.push(("Content-Type", "application/json"))
                }
                let expected_headers = headers
                    .into_iter()
                    .map(|(a, b)| (a.to_string(), b.to_string()))
                    .collect::<HashMap<_, _>>();
                assert_eq!(expected_headers, opts.headers);

                Ok(RestResponse {
                    status: 200,
                    headers: server_types_hash_header(),
					body: Some(
						br#"{"159":"Response to some request","160":"3000"}"#.to_vec(),
					),
                })
            });

		executor
	}

	pub fn maps_encrypted_data_and_response_data(
		http_method: HttpMethod,
		session_key: GenericAesKey,
	) -> ResolvingServiceExecutor {
		let executor = setup();
		let crypto_facade;
		let rest_client;
		let entity_facade;
		unsafe {
			crypto_facade = Arc::as_ptr(executor.crypto_facade.as_ref().unwrap())
				.cast::<CryptoFacade>()
				.cast_mut()
				.as_mut()
				.unwrap();
			rest_client = Arc::as_ptr(&executor.rest_client)
				.cast::<MockRestClient>()
				.cast_mut()
				.as_mut()
				.unwrap();

			entity_facade = Arc::as_ptr(&executor.entity_facade)
				.cast::<MockEntityFacade>()
				.cast_mut()
				.as_mut()
				.unwrap();
		}
		let owner_enc_session_key = [rand::random(); 32].to_vec();
		let owner_key_version = 0u64;

		rest_client
            .expect_request_binary()
            .return_once(move |url, method, opts| {
                if method == HttpMethod::GET {
                    assert_eq!(
                        "http://api.tuta.com/rest/test/encrypted-hello?_body=%7B%22359%22%3A%22my+encrypted+request%22%7D",
                        url.as_str()
                    );
                    assert_eq!(None, opts.body);
                } else {
                    assert_eq!(
                        "http://api.tuta.com/rest/test/encrypted-hello",
                        url.as_str()
                    );
				    assert_eq!(http_method, method);

                    let expected_body =
					serde_json::from_str::<RawEntity>(r#"{"359": "my encrypted request"}"#)
						.unwrap();
                    let body =
                        serde_json::from_slice::<RawEntity>(opts.body.unwrap().as_slice()).unwrap();
                    assert_eq!(expected_body, body);
                }
                assert_eq!(http_method, method);

				let mut headers = vec![
                    ("accessToken", "access_token"),
                    ("cv", CLIENT_VERSION),
                    ("v", APP_VERSION_STR),
                ];
                if method != HttpMethod::GET {
                    headers.push(("Content-Type", "application/json"));
                };

                let expected_headers = headers
                    .into_iter()
                    .map(|(a, b)| (a.to_string(), b.to_string()))
                    .collect::<HashMap<_, _>>();
                assert_eq!(expected_headers, opts.headers);

                Ok(RestResponse {
                    status: 200,
                    headers: server_types_hash_header(),
                    body: Some(
						br#"{ "459":"bXkgc2VjcmV0IHJlc3BvbnNl","460":"MzAwMA==" }"#
							.to_vec(),
                    ),
                })
            });

		let session_key_clone = session_key.clone();
		crypto_facade
			.expect_resolve_session_key()
			.returning(move |_entity, model| {
				assert_eq!(
					(AppName::Test, "HelloEncOutput"),
					(model.app, model.name.as_str())
				);
				assert!(model.marked_encrypted());

				Ok(Some(ResolvedSessionKey {
					session_key: session_key_clone.clone(),
					owner_enc_session_key: owner_enc_session_key.clone(),
					owner_key_version,
					sender_identity_pub_key: None,
				}))
			});

		let session_key_clone = session_key.clone();
		entity_facade
			.expect_encrypt_and_map()
			.return_once(move |_, instance, sk| {
				assert_eq!(&session_key_clone, sk);
				Ok(instance.clone())
			});

		let provider = mock_type_model_provider();
		let session_key_clone = session_key.clone();
		entity_facade.expect_decrypt_and_map().return_once(
			move |_, mut entity, resolved_session_key| {
				let type_model = provider
					.resolve_server_type_ref(&HelloEncOutput::type_ref())
					.expect("missing type");
				assert_eq!(session_key_clone, resolved_session_key.session_key);
				let timestamp_attribute_id = &type_model
					.get_attribute_id_by_attribute_name("timestamp")
					.unwrap();
				let answer_attribute_id = &type_model
					.get_attribute_id_by_attribute_name("answer")
					.unwrap();
				assert_eq!(
					&ElementValue::Bytes(BASE64_STANDARD.decode(r#"MzAwMA=="#).unwrap()),
					entity.get(timestamp_attribute_id).unwrap()
				);
				assert_eq!(
					&ElementValue::Bytes(
						BASE64_STANDARD
							.decode(r#"bXkgc2VjcmV0IHJlc3BvbnNl"#)
							.unwrap()
					),
					entity.get(answer_attribute_id).unwrap()
				);

				entity.insert(
					answer_attribute_id.to_owned(),
					ElementValue::String(String::from("my secret response")),
				);
				entity.insert(
					timestamp_attribute_id.to_owned(),
					ElementValue::Date(DateTime::from_millis(3000)),
				);
				entity.insert("_finalIvs".to_string(), ElementValue::Dict(HashMap::new()));
				Ok(entity.clone())
			},
		);

		executor
	}
}
