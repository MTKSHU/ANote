import { HttpException } from "@nestjs/common";
export function fail(status: number, error: string): never {
  throw new HttpException({ error }, status);
}
export function text(value: unknown, label: string, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(400, label + "无效");
  return value.trim();
}
export function optionalText(value: unknown, max = 2000) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > max)
    fail(400, "文本长度或格式无效");
  return value;
}
export function identifier(value: unknown) {
  if (typeof value !== "string" || !/^[-\w]{1,80}$/.test(value))
    fail(400, "ID 无效");
  return value;
}
