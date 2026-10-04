function isOfficialOpenAIResponsesBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    return (
      url.origin === "https://api.openai.com" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.replace(/\/+$/, "") === "/v1"
    );
  } catch {
    return false;
  }
}

export function supportsNativeOpenAIResponsesEndpoint(params: {
  provider: string;
  api: string;
  baseUrl?: string;
}): boolean {
  return (
    params.provider.trim().toLowerCase() === "openai" &&
    params.api === "openai-responses" &&
    isOfficialOpenAIResponsesBaseUrl(params.baseUrl)
  );
}

export function supportsOpenAIResponsesWebSocketEndpoint(params: {
  provider: string;
  api: string;
  baseUrl?: string;
  compat?: unknown;
}): boolean {
  if (supportsNativeOpenAIResponsesEndpoint(params)) {
    return true;
  }
  if (
    params.api !== "openai-responses" ||
    !params.compat ||
    typeof params.compat !== "object" ||
    !("supportsResponsesWebSocket" in params.compat) ||
    params.compat.supportsResponsesWebSocket !== true
  ) {
    return false;
  }
  try {
    const url = new URL(params.baseUrl ?? "");
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]"))) &&
      url.hostname !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
