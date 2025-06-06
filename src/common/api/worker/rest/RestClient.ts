import { assertWorkerOrNode, getApiBaseUrl, isAdminClient, isAndroidApp, isWebClient, isWorker } from "../../common/Env"
import { ConnectionError, handleRestError, PayloadTooLargeError, ServiceUnavailableError, TooManyRequestsError } from "../../common/error/RestError"
import { HttpMethod, MediaType, ServerModelInfo } from "../../common/EntityFunctions"
import { assertNotNull, typedEntries, uint8ArrayToArrayBuffer } from "@tutao/tutanota-utils"
import { SuspensionHandler } from "../SuspensionHandler"
import { REQUEST_SIZE_LIMIT_DEFAULT, REQUEST_SIZE_LIMIT_MAP } from "../../common/TutanotaConstants"
import { SuspensionError } from "../../common/error/SuspensionError.js"
import { ApplicationTypesFacade } from "../facades/ApplicationTypesFacade"

import { newPromise } from "@tutao/tutanota-utils/dist/Utils"

assertWorkerOrNode()

const TAG = "[RestClient]"

// visibleForTesting
export const APPLICATION_TYPES_HASH_HEADER = "app-types-hash"

interface ProgressListener {
	upload(percent: number): void

	download(percent: number): void
}

export const enum SuspensionBehavior {
	Suspend,
	Throw,
}

export interface RestClientOptions {
	body?: string | Uint8Array
	responseType?: MediaType
	progressListener?: ProgressListener
	baseUrl?: string
	headers?: Dict
	queryParams?: Dict
	noCORS?: boolean
	/** Default is to suspend all requests on rate limit. */
	suspensionBehavior?: SuspensionBehavior
}

/**
 * Allows REST communication with the server.
 * The RestClient observes upload/download progress and times
 * out in case no data is sent or received for a certain time.
 *
 * Uses XmlHttpRequest as there is still no support for tracking
 * upload progress with fetch (see https://stackoverflow.com/a/69400632)
 */
export class RestClient {
	private id: number
	// accurate to within a few seconds, depending on network speed
	private serverTimeOffsetMs: number | null = null

	constructor(
		private readonly suspensionHandler: SuspensionHandler,
		private readonly domainConfig: DomainConfig,
		private readonly serverModelInfo: ServerModelInfo,
	) {
		this.id = 0
	}

	request(path: string, method: HttpMethod, options: RestClientOptions = {}): Promise<any | null> {
		// @ts-ignore
		const debug = typeof self !== "undefined" && self.debug
		const verbose = isWorker() && debug

		this.checkRequestSizeLimit(path, method, options.body ?? null)

		if (this.suspensionHandler.isSuspended()) {
			return this.suspensionHandler.deferRequest(() => this.request(path, method, options))
		} else {
			return newPromise((resolve, reject) => {
				this.id++

				const queryParams: Dict = options.queryParams ?? {}

				if (method === HttpMethod.GET && typeof options.body === "string") {
					queryParams["_body"] = options.body // get requests are not allowed to send a body. Therefore, we convert our body to a parameter
				}

				if (options.noCORS) {
					queryParams["cv"] = env.versionNumber
					if (env.networkDebugging) {
						queryParams["network-debugging"] = "enable-network-debugging"
					}
				}

				const origin = options.baseUrl ?? getApiBaseUrl(this.domainConfig)
				const resourceURL = new URL(origin)
				resourceURL.pathname = path
				const url = addParamsToUrl(resourceURL, queryParams)
				const xhr = new XMLHttpRequest()
				xhr.open(method, url.toString())

				this.setHeaders(xhr, options)

				xhr.responseType = options.responseType === MediaType.Json || options.responseType === MediaType.Text ? "text" : "arraybuffer"

				const abortAfterTimeout = () => {
					const res = {
						timeoutId: 0 as TimeoutID,
						abortFunction: () => {
							if (this.usingTimeoutAbort()) {
								console.log(TAG, `${this.id}: ${String(new Date())} aborting ` + String(res.timeoutId))
								xhr.abort()
							}
						},
					}
					return res
				}

				const t = abortAfterTimeout()
				let timeout = setTimeout(t.abortFunction, env.timeout)
				t.timeoutId = timeout

				if (verbose) {
					console.log(TAG, `${this.id}: set initial timeout ${String(timeout)} of ${env.timeout}`)
				}

				xhr.onload = async () => {
					try {
						// XMLHttpRequestProgressEvent, but not needed
						if (verbose) {
							console.log(TAG, `${this.id}: ${String(new Date())} finished request. Clearing Timeout ${String(timeout)}.`)
						}

						clearTimeout(timeout)

						this.saveServerTimeOffsetFromRequest(xhr)

						// handle new server model and update the applicationTypesJson file if applicable
						const applicationTypesHashResponseHeader = xhr.getResponseHeader(APPLICATION_TYPES_HASH_HEADER)
						if (applicationTypesHashResponseHeader != null) {
							this.serverModelInfo.setCurrentHash(applicationTypesHashResponseHeader)
						}

						if (xhr.status === 200 || (method === HttpMethod.POST && xhr.status === 201)) {
							if (options.responseType === MediaType.Json || options.responseType === MediaType.Text) {
								resolve(xhr.response)
							} else if (options.responseType === MediaType.Binary) {
								resolve(new Uint8Array(xhr.response))
							} else {
								resolve(null)
							}
						} else {
							const suspensionTime = xhr.getResponseHeader("Retry-After") || xhr.getResponseHeader("Suspension-Time")

							if (isSuspensionResponse(xhr.status, suspensionTime) && options.suspensionBehavior === SuspensionBehavior.Throw) {
								reject(
									new SuspensionError(
										`blocked for ${suspensionTime}, not suspending (${xhr.status})`,
										suspensionTime && (parseInt(suspensionTime) * 1000).toString(),
									),
								)
							} else if (isSuspensionResponse(xhr.status, suspensionTime)) {
								this.suspensionHandler.activateSuspensionIfInactive(Number(suspensionTime), resourceURL)

								resolve(this.suspensionHandler.deferRequest(() => this.request(path, method, options)))
							} else {
								logFailedRequest(method, url, xhr, options)
								reject(
									handleRestError(
										xhr.status,
										`| ${method} ${path}`,
										xhr.getResponseHeader("Error-Id"),
										xhr.getResponseHeader("Precondition"),
									),
								)
							}
						}
					} catch (e) {
						const msg = "unexpected error in RestClient::onload handler: "
						console.error(msg, e)
						reject(msg + e.stack)
					}
				}

				xhr.onerror = function () {
					try {
						clearTimeout(timeout)
						logFailedRequest(method, url, xhr, options)
						reject(handleRestError(xhr.status, ` | ${method} ${path}`, xhr.getResponseHeader("Error-Id"), xhr.getResponseHeader("Precondition")))
					} catch (e) {
						const msg = "unexpected error in RestClient::onerror handler: "
						console.error(msg, e)
						reject(msg + e.stack)
					}
				}

				// don't add an EventListener for non-CORS requests, otherwise it would not meet the 'CORS-Preflight simple request' requirements
				if (!options.noCORS) {
					xhr.upload.onprogress = (pe: ProgressEvent) => {
						if (verbose) {
							console.log(TAG, `${this.id}: ${String(new Date())} upload progress. Clearing Timeout ${String(timeout)}`, pe)
						}

						clearTimeout(timeout)
						const t = abortAfterTimeout()
						timeout = setTimeout(t.abortFunction, env.timeout)
						t.timeoutId = timeout

						if (verbose) {
							console.log(TAG, `${this.id}: set new timeout ${String(timeout)} of ${env.timeout}`)
						}

						if (options.progressListener != null && pe.lengthComputable) {
							// see https://developer.mozilla.org/en-US/docs/Web/API/ProgressEvent
							options.progressListener.upload((1 / pe.total) * pe.loaded)
						}
					}

					xhr.upload.ontimeout = (e) => {
						if (verbose) {
							console.log(TAG, `${this.id}: ${String(new Date())} upload timeout. calling error handler.`, e)
						}
						xhr.onerror?.(e)
					}

					xhr.upload.onerror = (e) => {
						if (verbose) {
							console.log(TAG, `${this.id}: ${String(new Date())} upload error. calling error handler.`, e)
						}
						xhr.onerror?.(e)
					}

					xhr.upload.onabort = (e) => {
						if (verbose) {
							console.log(TAG, `${this.id}: ${String(new Date())} upload aborted. calling error handler.`, e)
						}
						xhr.onerror?.(e)
					}
				}

				xhr.onprogress = (pe: ProgressEvent) => {
					if (verbose) {
						console.log(TAG, `${this.id}: ${String(new Date())} download progress. Clearing Timeout ${String(timeout)}`, pe)
					}

					clearTimeout(timeout)
					let t = abortAfterTimeout()
					timeout = setTimeout(t.abortFunction, env.timeout)
					t.timeoutId = timeout

					if (verbose) {
						console.log(TAG, `${this.id}: set new timeout ${String(timeout)} of ${env.timeout}`)
					}

					if (options.progressListener != null && pe.lengthComputable) {
						// see https://developer.mozilla.org/en-US/docs/Web/API/ProgressEvent
						options.progressListener.download((1 / pe.total) * pe.loaded)
					}
				}

				xhr.onabort = () => {
					clearTimeout(timeout)
					reject(new ConnectionError(`Reached timeout of ${env.timeout}ms ${xhr.statusText} | ${method} ${path}`))
				}

				if (options.body instanceof Uint8Array) {
					xhr.send(uint8ArrayToArrayBuffer(options.body))
				} else {
					xhr.send(options.body)
				}
			}, "restClient:request")
		}
	}

	/** We only need to track timeout directly here on some platforms. Other platforms do it inside their network driver. */
	private usingTimeoutAbort() {
		return isWebClient() || isAndroidApp()
	}

	private saveServerTimeOffsetFromRequest(xhr: XMLHttpRequest) {
		// Dates sent in the `Date` field of HTTP headers follow the format specified by rfc7231
		// JavaScript's Date expects dates in the format specified by rfc2822
		// rfc7231 provides three options of formats, the preferred one being IMF-fixdate. This one is definitely
		// parseable by any rfc2822 compatible parser, since it is a strict subset (with no folding white space) of the
		// format of rfc5322, which is the same as rfc2822 accepting more folding white spaces.
		// Furthermore, there is no reason to expect the server to return any of the other two accepted formats, which
		// are obsolete and accepted only for backwards compatibility.
		const serverTimestamp = xhr.getResponseHeader("Date")

		if (serverTimestamp != null) {
			// check that serverTimestamp has been returned
			const serverTime = new Date(serverTimestamp).getTime()

			if (!isNaN(serverTime)) {
				const now = Date.now()
				this.serverTimeOffsetMs = serverTime - now
			}
		}
	}

	/**
	 * Get the time on the server based on the client time + the server time offset
	 * The server time offset is calculated based on the date field in the header returned from REST requests.
	 * will throw an error if offline or no rest requests have been made yet
	 */
	getServerTimestampMs(): number {
		const timeOffset = assertNotNull(this.serverTimeOffsetMs, "You can't get server time if no rest requests were made")
		return Date.now() + timeOffset
	}

	/**
	 * Checks if the request body is too large.
	 * Ignores the method because GET requests etc. should not exceed the limits neither.
	 * This is done to avoid making the request, because the server will return a PayloadTooLargeError anyway.
	 * */
	private checkRequestSizeLimit(path: string, method: HttpMethod, body: string | Uint8Array | null) {
		if (isAdminClient()) {
			return
		}

		const limit = REQUEST_SIZE_LIMIT_MAP.get(path) ?? REQUEST_SIZE_LIMIT_DEFAULT

		if (body && body.length > limit) {
			throw new PayloadTooLargeError(`request body is too large. Path: ${path}, Method: ${method}, Body length: ${body.length}`)
		}
	}

	private setHeaders(xhr: XMLHttpRequest, options: RestClientOptions) {
		if (options.headers == null) {
			options.headers = {}
		}
		const { headers, body, responseType } = options

		// don't add custom and content-type headers for non-CORS requests, otherwise it would not meet the 'CORS-Preflight simple request' requirements
		if (!options.noCORS) {
			headers["cv"] = env.versionNumber
			if (body instanceof Uint8Array) {
				headers["Content-Type"] = MediaType.Binary
			} else if (typeof body === "string") {
				headers["Content-Type"] = MediaType.Json
			}

			// add networkDebugging header iff network debugging is activated
			// network debugging can be activated by building with --network-debugging,
			// and essentially activates both attributeNames and attributeIds in the request/response payload
			if (env.networkDebugging) {
				headers["Network-Debugging"] = "enable-network-debugging"
			}
		}

		if (env.clientName != null) {
			headers["Client-Name"] = env.clientName
		}

		if (responseType) {
			headers["Accept"] = responseType
		}
		for (const i in headers) {
			xhr.setRequestHeader(i, headers[i])
		}
	}
}

export function addParamsToUrl(url: URL, urlParams: Dict): URL {
	if (urlParams) {
		for (const [key, value] of typedEntries(urlParams)) {
			if (value !== undefined) {
				url.searchParams.set(key, value)
			}
		}
	}

	return url
}

export function isSuspensionResponse(statusCode: number, suspensionTimeNumberString: string | null): boolean {
	return Number(suspensionTimeNumberString) > 0 && (statusCode === TooManyRequestsError.CODE || statusCode === ServiceUnavailableError.CODE)
}

function logFailedRequest(method: HttpMethod, url: URL, xhr: XMLHttpRequest, options: RestClientOptions): void {
	const args: Array<unknown> = [TAG, "failed request", method, url.toString(), xhr.status, xhr.statusText]
	if (options.headers != null) {
		args.push(Object.keys(options.headers))
	}
	if (options.body != null) {
		const logBody = "string" === typeof options.body ? `[${options.body.length} characters]` : `[${options.body.length} bytes]`
		args.push(logBody)
	} else {
		args.push("no body")
	}
	console.log(...args)
}
