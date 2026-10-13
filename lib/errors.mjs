export class BlueprintError extends Error {
  constructor(code, message, { status = 400, details, ...extra } = {}) {
    super(message);
    this.name = 'BlueprintError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    Object.assign(this, extra);
  }
}
