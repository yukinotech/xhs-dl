// Public wire-protocol constants observed in references-lock.json snapshots.
// No upstream runtime, source bundle, or browser code is loaded at runtime.
export const XS_ALPHABET =
  "ZmserbBoHQtNP+wOcza/LpngG8yJq42KWYj0DSfdikx3VT16IlUAFM97hECvuRX5";
export const MNS_ALPHABET =
  "MfgqrsbcyzPQRStuvC7mn501HIJBo2DEFTKdeNOwxWXYZap89+/A4UVLhijkl63G";
export const MNS58_ALPHABET =
  "NOPQRStuvwxWXYZabcyz012DEFTKLMdefghijkl4563GHIJBC7mnop89+/";
export const STREAM_0101 =
  "r1crlcplstnsdrtdLpfLZTKZzGYzmcxmM5nM5nM5nM5nMxkMBgMBAAAAAACAQCCQSCQSicTicTgcDgcDAYBAoFAoFIrFYjEYDAaDwWAwmEwmk8lkslmsVqvV6vX6/X4/n08nk0mk0ul0Op1OJ5NJpNLp9Ho9Ho9HI5FIpNJpNBqNRiMRCIRCIZDIZDKZTKbT6XS63e53Ox2OR6NRKBSKxQ==";
export const STREAM_0301 =
  "caMCJXeTJx3dJzvO4+S5jZ15NeHaM/V2Xi6or7bcd6UaSZ0jtnwgZgAlhgy/E9RUDZJJf1hobFdOUI9G4ZVjRPOROb9PryKj7vEgt5JYFFsv61GTtkeGaZYSmOeb7cpkbhppOpJhVKWnob0c8N7bdC+RenR6HjiLI08id1FttxFgNUOXMPph6YIqDsp7/3LYuiyDzNAm7K7b0M8PE+qxGc";
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
export const WEB_BUILD = "6.47.2";
export const stages = {
  security: {
    tier: "0201",
    environment: 1322,
    tail: "f8536767c9b581635e0744fa8415",
  },
  callback: {
    tier: "0101",
    environment: 1332,
    tail: "f9526767c9b581635e0744fa8415",
  },
  activate: {
    tier: "0101",
    environment: 1335,
    tail: "f9526767c9b581635e0744fa8415",
  },
  qrCreate: {
    tier: "0301",
    environment: 1350,
    tail: "f9416767c9b581635e0744fa8415",
  },
  qrPoll: {
    tier: "0301",
    environment: 1351,
    tail: "f9416767c9b581635e0744fa8415",
  },
  steady: {
    tier: "0301",
    environment: 1352,
    tail: "f9416767c9b581635e0744fa8415",
  },
  profile: {
    tier: "0301",
    environment: 1358,
    tail: "f9416767c9b581635e0744fa8415",
  },
} as const;
export type Stage = keyof typeof stages;
