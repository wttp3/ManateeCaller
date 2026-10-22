/**
 * Calling codes, longest first so 353 matches before any shorter prefix.
 * Used to require a real country code and to drop a national trunk 0.
 */
const CALLING_CODES = [
  "1242", "1246", "1264", "1268", "1284", "1340", "1345", "1441", "1473", "1649", "1664", "1670", "1671",
  "1684", "1721", "1758", "1767", "1784", "1787", "1809", "1829", "1849", "1868", "1869", "1876", "1939",
  "211", "212", "213", "216", "218", "220", "221", "222", "223", "224", "225", "226", "227", "228", "229",
  "230", "231", "232", "233", "234", "235", "236", "237", "238", "239", "240", "241", "242", "243", "244",
  "245", "246", "248", "249", "250", "251", "252", "253", "254", "255", "256", "257", "258", "260", "261",
  "262", "263", "264", "265", "266", "267", "268", "269", "290", "291", "297", "298", "299",
  "350", "351", "352", "353", "354", "355", "356", "357", "358", "359", "370", "371", "372", "373", "374",
  "375", "376", "377", "378", "380", "381", "382", "385", "386", "387", "389",
  "420", "421", "423",
  "500", "501", "502", "503", "504", "505", "506", "507", "508", "509", "590", "591", "592", "593", "594",
  "595", "596", "597", "598", "599",
  "670", "672", "673", "674", "675", "676", "677", "678", "679", "680", "681", "682", "683", "685", "686",
  "687", "688", "689", "690", "691", "692",
  "850", "852", "853", "855", "856", "880", "886",
  "960", "961", "962", "963", "964", "965", "966", "967", "968", "970", "971", "972", "973", "974", "975",
  "976", "977", "992", "993", "994", "995", "996", "998",
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84",
  "86", "90", "91", "92", "93", "94", "95", "98",
  "1", "7",
];

/** Countries whose national trunk prefix is 0 and is omitted in E.164. Italy (39) keeps its 0. */
const TRUNK_ZERO_CODES = new Set([
  "20", "27", "31", "32", "33", "36", "41", "43", "44", "46", "48", "49",
  "52", "54", "55", "56", "57", "60", "61", "62", "63", "64", "66",
  "81", "82", "84", "86", "90", "91", "92", "94",
  "212", "213", "233", "234", "254", "255", "256",
  "353", "358", "380", "381", "385", "386", "387", "421",
  "855", "856", "880", "886", "972", "977",
]);

export function matchCallingCode(digits: string): string | null {
  for (const code of CALLING_CODES) {
    if (digits.startsWith(code)) {
      return code;
    }
  }
  return null;
}

function stripTrunkZero(e164: string): string {
  const digits = e164.slice(1);
  const code = matchCallingCode(digits);
  if (!code || !TRUNK_ZERO_CODES.has(code)) {
    return e164;
  }
  if (digits.charAt(code.length) !== "0") {
    return e164;
  }
  return `+${code}${digits.slice(code.length + 1)}`;
}

export function normalizePhone(raw: string): string {
  const withoutTrunkMarker = raw.trim().replace(/\(0\)/g, "");
  let digits = withoutTrunkMarker.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) {
    digits = `+${digits.slice(2)}`;
  } else if (!digits.startsWith("+")) {
    digits = digits.startsWith("0") ? `+44${digits.slice(1)}` : `+${digits}`;
  }
  if (digits.startsWith("+")) {
    digits = stripTrunkZero(digits);
  }
  return digits;
}

export function isValidE164(phone: string): boolean {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    return false;
  }
  const digits = phone.slice(1);
  const code = matchCallingCode(digits);
  if (!code) {
    return false;
  }
  const national = digits.slice(code.length);
  if (national.length === 0) {
    return false;
  }
  if (TRUNK_ZERO_CODES.has(code) && national.startsWith("0")) {
    return false;
  }
  return true;
}
