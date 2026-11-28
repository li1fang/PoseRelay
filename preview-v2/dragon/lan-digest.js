// The archived demo uses WebCrypto, which browsers only expose in a secure context.
// On a home HTTP address provide its one required operation in this document.
if (!globalThis.crypto.subtle) {
  Object.defineProperty(globalThis.crypto, "subtle", {value: {
    async digest(algorithm, bytes) {
      if (algorithm !== "SHA-256") throw new Error("Unsupported demo digest");
      return globalThis.sha256.arrayBuffer(bytes);
    }
  }});
}
