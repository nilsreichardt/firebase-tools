import { promisify } from "util";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import * as portfinder from "portfinder";
import * as spawn from "cross-spawn";

import { FirebaseError } from "../../../../error";
import { Options } from "../../../../options";
import { logger } from "../../../../logger";
import * as args from "../../args";
import * as backend from "../../backend";
import * as discovery from "../discovery";
import * as getProjectId from "../../../../getProjectId";
import * as modules from "./modules";
import * as runtimes from "..";

const VERSION_TO_RUNTIME: Record<string, runtimes.Runtime> = {
  "1.13": "go113",
};
export const ADMIN_SDK = "firebase.google.com/go/v4";
export const FUNCTIONS_SDK = "github.com/inlined/go-functions";

// Because codegen is a separate binary we won't automatically import it
// when we import the library.
export const FUNCTIONS_CODEGEN = FUNCTIONS_SDK + "/support/codegen";

// Because emulator isn't called until codegen happens, we won't automatically
// import it either.
export const FUNCTIONS_EMULATOR = FUNCTIONS_SDK + "/support/emulator";

export async function tryCreateDelegate(
  context: args.Context,
  options: Options
): Promise<Delegate | undefined> {
  const sourceDirName = options.config.get("functions.source") as string;
  const sourceDir = options.config.path(sourceDirName);
  const goModPath = path.join(sourceDir, "go.mod");
  const projectId = getProjectId(options);

  let module: modules.Module;
  try {
    const modBuffer = await promisify(fs.readFile)(goModPath);
    module = modules.parseModule(modBuffer.toString("utf8"));
  } catch (err) {
    logger.debug("Customer code is not Golang code (or they aren't using modules)");
    return;
  }

  let runtime = options.config.get("functions.runtime");
  if (!runtime) {
    if (!module.version) {
      throw new FirebaseError("Could not detect Golang version from go.mod");
    }
    if (!VERSION_TO_RUNTIME[module.version]) {
      throw new FirebaseError(
        `go.mod specifies Golang version ${
          module.version
        } which is unsupported by Google Cloud Functions. Valid values are ${Object.keys(
          VERSION_TO_RUNTIME
        ).join(", ")}`
      );
    }
    runtime = VERSION_TO_RUNTIME[module.version];
  }

  return new Delegate(projectId, sourceDir, runtime, module);
}

// A module can be much more complicated than this, but this is all we need so far.
// for a full reference, see https://golang.org/doc/modules/gomod-ref
export class Delegate {
  public readonly name = "golang";

  constructor(
    private readonly projectId: string,
    private readonly sourceDir: string,
    public readonly runtime: runtimes.Runtime,
    private readonly module: modules.Module
  ) {}
  validate(): Promise<void> {
    // throw new FirebaseError("Cannot yet analyze Go source code");
    return Promise.resolve();
  }

  async build(): Promise<void> {
    try {
      await promisify(fs.mkdir)(path.join(this.sourceDir, "autogen"));
    } catch (err) {
      if (!/EEXIST/.exec(err?.message)) {
        throw new FirebaseError("Failed to create codegen directory", { children: [err] });
      }
    }
    const getDeps = spawn.sync("go", ["run", FUNCTIONS_CODEGEN, this.module.module], {
      cwd: this.sourceDir,
      stdio: [/* stdin=*/ "ignore", /* stdout=*/ "pipe", /* stderr=*/ "pipe"],
    });
    if (getDeps.status != 0) {
      throw new FirebaseError("Failed to run codegen", {
        children: [new Error(getDeps.stderr.toString())],
      });
    }
    await promisify(fs.writeFile)(path.join(this.sourceDir, "autogen", "main.go"), getDeps.stdout);
  }

  // Watch isn't supported for Go
  watch(): Promise<() => Promise<void>> {
    return Promise.resolve(() => Promise.resolve());
  }

  serve(
    port: number,
    adminPort: number,
    envs: backend.EnvironmentVariables
  ): Promise<() => Promise<void>> {
    const childProcess = spawn("go", ["run", "./autogen"], {
      env: {
        ...envs,
        ...process.env,
        GOPATH: process.env.GOPATH,
        PORT: port.toString(),
        ADMIN_PORT: adminPort.toString(),
        PATH: process.env.PATH,
      },
      cwd: this.sourceDir,
      stdio: [/* stdin=*/ "ignore", /* stdout=*/ "pipe", /* stderr=*/ "inherit"],
    });
    childProcess.stdout.on("data", (chunk) => {
      logger.debug(chunk);
    });
    return Promise.resolve(async () => {
      const p = new Promise<void>((resolve, reject) => {
        childProcess.once("exit", resolve);
        childProcess.once("error", reject);
      });

      // If we SIGKILL the child process we're actually going to kill the go
      // runner and the webserver it launched will keep running.
      await fetch(`http://localhost:${adminPort}/quitquitquit`);
      setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill("SIGKILL");
        }
      }, 10_000);
      return p;
    });
  }

  async discoverSpec(
    configValues: backend.RuntimeConfigValues,
    envs: backend.EnvironmentVariables
  ): Promise<backend.Backend> {
    let discovered = await discovery.detectFromYaml(this.sourceDir, this.projectId, this.runtime);
    if (!discovered) {
      const port = await promisify(portfinder.getPort)() as number;
      const adminPort = await promisify(portfinder.getPort)() as number;

      const kill = await this.serve(port, adminPort, envs);
      try {
        discovered = await discovery.detectFromPort(8081, this.projectId, this.runtime);
      } finally {
        await kill();
      }
    }
    discovered.environmentVariables = envs;
    return discovered;
  }
}
