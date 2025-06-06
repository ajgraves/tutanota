import tutasdk

public class SdkRestClient: RestClient {
	private let urlSession: URLSession
	public init(urlSession: URLSession) { self.urlSession = urlSession }
	public func requestBinary(url: String, method: tutasdk.HttpMethod, options: tutasdk.RestClientOptions) async throws -> tutasdk.RestResponse {
		do {
			var request = URLRequest(url: URL(string: url)!)
			request.httpMethod =
				switch method {
				case .get: "get"
				case .post: "post"
				case .delete: "delete"
				case .put: "put"
				}
			for (key, value) in options.headers { request.setValue(value, forHTTPHeaderField: key) }
			request.httpBody = options.body
			let (data, urlResponse) = try await self.urlSession.data(for: request)
			let httpUrlResponse = urlResponse as! HTTPURLResponse  // We should only ever receive HTTP URLs
			guard let headers = httpUrlResponse.allHeaderFields as? [String: String] else {
				throw TUTErrorFactory.createError("Response headers were not a [String:String]")
			}
			return RestResponse(status: UInt32(httpUrlResponse.statusCode), headers: headers, body: data)
		} catch { throw mapExceptionToError(e: error) }
	}
	// see: SdkFileClient::mapExceptionToError
	private func mapExceptionToError(e: Error) -> RestClientError {
		// why we don't match on e? see: sdkFileClient::mapExceptionToError
		TUTSLog("Exception in SdkRestClient: \(e). Assuming .Unknown")
		return RestClientError.Unknown
	}
}
