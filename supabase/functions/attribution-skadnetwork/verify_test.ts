import { verifyPostback } from "./verify.ts";
// Signed test vectors from Apple’s StoreKit verification documentation.
const vectors = [
  {
    "version": "2.2",
    "ad-network-id": "com.example",
    "campaign-id": 42,
    "transaction-id": "6aafb7a5-0170-41b5-bbe4-fe71dedf1e28",
    "app-id": 525463029,
    "attribution-signature":
      "MEYCIQDTuQ1Z4Tpy9D3aEKbxLl5J5iKiTumcqZikuY/AOD2U7QIhAJAaiAv89AoquHXJffcieEQXdWHpcV8ZgbKN0EwV9/sY",
    "redownload": true,
    "source-app-id": 1234567891,
    "fidelity-type": 1,
    "conversion-value": 20,
  },
  {
    "version": "3.0",
    "ad-network-id": "example123.skadnetwork",
    "campaign-id": 42,
    "transaction-id": "6aafb7a5-0170-41b5-bbe4-fe71dedf1e28",
    "app-id": 525463029,
    "attribution-signature":
      "MEYCIQD5eq3AUlamORiGovqFiHWI4RZT/PrM3VEiXUrsC+M51wIhAPMANZA9c07raZJ64gVaXhB9+9yZj/X6DcNxONdccQij",
    "redownload": true,
    "source-app-id": 1234567891,
    "fidelity-type": 1,
    "conversion-value": 20,
    "did-win": true,
  },
  {
    "version": "3.0",
    "ad-network-id": "example123.skadnetwork",
    "campaign-id": 42,
    "transaction-id": "f9ac267a-a889-44ce-b5f7-0166d11461f0",
    "app-id": 525463029,
    "attribution-signature":
      "MEUCIQDDetUtkyc/MiQvVJ5I6HIO1E7l598572Wljot2Onzd4wIgVJLzVcyAV+TXksGNoa0DTMXEPgNPeHCmD4fw1ABXX0g=",
    "redownload": true,
    "fidelity-type": 1,
    "did-win": false,
  },
  {
    "version": "4.0",
    "ad-network-id": "com.example",
    "source-identifier": "5239",
    "app-id": 525463029,
    "transaction-id": "6aafb7a5-0170-41b5-bbe4-fe71dedf1e30",
    "redownload": false,
    "source-domain": "example.com",
    "fidelity-type": 1,
    "did-win": true,
    "conversion-value": 63,
    "postback-sequence-index": 0,
    "attribution-signature":
      "MEUCIGRmSMrqedNu6uaHyhVcifs118R5z/AB6cvRaKrRRHWRAiEAv96ne3dKQ5kJpbsfk4eYiePmrZUU6sQmo+7zfP/1Bxo=",
  },
  {
    "version": "4.0",
    "ad-network-id": "com.example",
    "source-identifier": "39",
    "app-id": 525463029,
    "transaction-id": "6aafb7a5-0170-41b5-bbe4-fe71dedf1e31",
    "redownload": false,
    "source-domain": "example.com",
    "fidelity-type": 1,
    "did-win": true,
    "coarse-conversion-value": "high",
    "postback-sequence-index": 0,
    "attribution-signature":
      "MEUCIQD4rX6eh38qEhuUKHdap345UbmlzA7KEZ1bhWZuYM8MJwIgMnyiiZe6heabDkGwOaKBYrUXQhKtF3P/ERHqkR/XpuA=",
  },
];
Deno.test("Apple-signed postbacks validate across privacy tiers and versions", async () => {
  if (vectors.length < 4) throw Error("expected official examples");
  for (const row of vectors) {
    if (!await verifyPostback(row)) {
      throw Error("valid postback rejected: " + row.version);
    }
    if (await verifyPostback({ ...row, "app-id": 9999999 })) {
      throw Error("changed signed field was accepted");
    }
  }
});
Deno.test("unsigned conversion values are excluded from verified measurements", async () => {
  const row = await verifyPostback({ ...vectors[0], "conversion-value": 43 });
  if (!row || "conversion-value" in row) {
    throw Error("Unexpected unsigned data");
  }
});
