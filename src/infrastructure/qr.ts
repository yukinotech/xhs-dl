import QRCode from "qrcode";
import { AppError } from "../domain/errors.js";

export function terminalQr(text: string, theme = "dark") {
  if (!["dark", "light"].includes(theme))
    throw new AppError(
      "INVALID_ARGUMENT",
      "qr-theme 只能为 dark 或 light。",
      2,
    );
  const matrix = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
  const margin = 4,
    size = matrix.size + margin * 2;
  const pixel = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < matrix.size && y < matrix.size
      ? !!matrix.get(y, x)
      : false;
  const filled = (x: number, y: number) =>
    theme === "light" ? pixel(x, y) : !pixel(x, y);
  let rendered = "";
  for (let y = -margin; y < matrix.size + margin; y += 2) {
    for (let x = -margin; x < matrix.size + margin; x++) {
      const top = filled(x, y),
        bottom = filled(x, y + 1);
      rendered += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    rendered += "\n";
  }
  return { text: rendered, columns: size, rows: Math.ceil(size / 2), theme };
}
