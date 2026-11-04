export function renderServiceWorker(template: string, values: { version: string; urls: string[]; base: string }): string {
  return template
    .split("__SW_VERSION__").join(values.version)
    .split("__SW_URLS__").join(JSON.stringify(values.urls))
    .split("__SW_BASE__").join(values.base);
}
