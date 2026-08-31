export class ConfigurationError extends Error {
  readonly code = "configuration_error";

  constructor(message = "The service is not configured.") {
    super(message);
    this.name = "ConfigurationError";
  }
}

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestError";
  }
}

export class NotFoundError extends Error {
  readonly code = "not_found";

  constructor(message = "The requested resource is unavailable.") {
    super(message);
    this.name = "NotFoundError";
  }
}

export class DatabaseBoundaryError extends Error {
  readonly code = "database_boundary_error";

  constructor(readonly databaseCode?: string) {
    super("The persistence boundary rejected the request.");
    this.name = "DatabaseBoundaryError";
  }
}
