# PrjLab CLI

Public CLI foundation for PrjLab. **Early development, not released to npm.**
Package/command names are provisional. This repository does not contain the
private hosted platform or its credentials.

## Build locally

Requires Node 22 and npm 10+:

```sh
npm ci --ignore-scripts
npm run build
node dist/bin.js --help
node dist/bin.js --version
```

This build supports help and version output only. Login, push, pull, clone and
search explicitly exit with an error because they are not implemented. It does
not read project files, store credentials or contact any service.

## Check changes

```sh
npm run typecheck
npm test
npm run test:package
```

GitHub Actions runs these checks on Linux, macOS and Windows, audits dependencies,
and scans for vulnerabilities and secrets. Package tests inspect the tarball,
install it into an isolated directory and execute the installed CLI. No npm
publishing workflow or registry credentials are configured.

## Intended workflow

Anyone will be able to install the released public npm package. Hosted operations
will authenticate to PrjLab; repository access will be enforced by the API, never
trusted solely to this client. A public CLI does not expose private user projects.

## License

Licensed under the [MIT License](LICENSE). The package remains marked private
to prevent accidental npm publication until the namespace and release are ready.

See SECURITY.md for private vulnerability reporting.
