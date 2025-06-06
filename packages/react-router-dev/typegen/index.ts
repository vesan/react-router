import fs from "node:fs";

import ts from "dedent";
import * as Path from "pathe";
import pc from "picocolors";
import type vite from "vite";

import { createConfigLoader } from "../config/config";
import * as Babel from "../vite/babel";

import { generate } from "./generate";
import type { Context } from "./context";
import { getTypesDir, getTypesPath } from "./paths";
import * as Params from "./params";
import * as Route from "./route";

export async function run(rootDirectory: string, { mode }: { mode: string }) {
  const ctx = await createContext({ rootDirectory, mode, watch: false });
  await writeAll(ctx);
}

export type Watcher = {
  close: () => Promise<void>;
};

export async function watch(
  rootDirectory: string,
  { mode, logger }: { mode: string; logger?: vite.Logger }
): Promise<Watcher> {
  const ctx = await createContext({ rootDirectory, mode, watch: true });
  await writeAll(ctx);
  logger?.info(pc.green("generated types"), { timestamp: true, clear: true });

  ctx.configLoader.onChange(
    async ({ result, configChanged, routeConfigChanged }) => {
      if (!result.ok) {
        logger?.error(pc.red(result.error), { timestamp: true, clear: true });
        return;
      }

      ctx.config = result.value;
      if (configChanged || routeConfigChanged) {
        await writeAll(ctx);
        logger?.info(pc.green("regenerated types"), {
          timestamp: true,
          clear: true,
        });
      }
    }
  );

  return {
    close: async () => await ctx.configLoader.close(),
  };
}

async function createContext({
  rootDirectory,
  watch,
  mode,
}: {
  rootDirectory: string;
  watch: boolean;
  mode: string;
}): Promise<Context> {
  const configLoader = await createConfigLoader({ rootDirectory, mode, watch });
  const configResult = await configLoader.getConfig();

  if (!configResult.ok) {
    throw new Error(configResult.error);
  }

  const config = configResult.value;

  return {
    configLoader,
    rootDirectory,
    config,
  };
}

async function writeAll(ctx: Context): Promise<void> {
  const typegenDir = getTypesDir(ctx);

  fs.rmSync(typegenDir, { recursive: true, force: true });
  Object.values(ctx.config.routes).forEach((route) => {
    const typesPath = getTypesPath(ctx, route);
    const content = generate(ctx, route);
    fs.mkdirSync(Path.dirname(typesPath), { recursive: true });
    fs.writeFileSync(typesPath, content);
  });

  const registerPath = Path.join(typegenDir, "+register.ts");
  fs.writeFileSync(registerPath, register(ctx));

  const virtualPath = Path.join(typegenDir, "+virtual.d.ts");
  fs.writeFileSync(virtualPath, virtual);
}

function register(ctx: Context) {
  const register = ts`
    import "react-router";

    declare module "react-router" {
      interface Register {
        params: Params;
      }

      interface Future {
        unstable_middleware: ${ctx.config.future.unstable_middleware}
      }
    }
  `;

  const { t } = Babel;

  const fullpaths = new Set<string>();
  Object.values(ctx.config.routes).forEach((route) => {
    if (route.id !== "root" && !route.path) return;
    const lineage = Route.lineage(ctx.config.routes, route);
    const fullpath = Route.fullpath(lineage);
    fullpaths.add(fullpath);
  });

  const typeParams = t.tsTypeAliasDeclaration(
    t.identifier("Params"),
    null,
    t.tsTypeLiteral(
      Array.from(fullpaths).map((fullpath) => {
        const params = Params.parse(fullpath);
        return t.tsPropertySignature(
          t.stringLiteral(fullpath),
          t.tsTypeAnnotation(
            t.tsTypeLiteral(
              Object.entries(params).map(([param, isRequired]) => {
                const property = t.tsPropertySignature(
                  t.stringLiteral(param),
                  t.tsTypeAnnotation(t.tsStringKeyword())
                );
                property.optional = !isRequired;
                return property;
              })
            )
          )
        );
      })
    )
  );

  return [register, Babel.generate(typeParams).code].join("\n\n");
}

const virtual = ts`
  declare module "virtual:react-router/server-build" {
    import { ServerBuild } from "react-router";
    export const assets: ServerBuild["assets"];
    export const assetsBuildDirectory: ServerBuild["assetsBuildDirectory"];
    export const basename: ServerBuild["basename"];
    export const entry: ServerBuild["entry"];
    export const future: ServerBuild["future"];
    export const isSpaMode: ServerBuild["isSpaMode"];
    export const prerender: ServerBuild["prerender"];
    export const publicPath: ServerBuild["publicPath"];
    export const routeDiscovery: ServerBuild["routeDiscovery"];
    export const routes: ServerBuild["routes"];
    export const ssr: ServerBuild["ssr"];
    export const unstable_getCriticalCss: ServerBuild["unstable_getCriticalCss"];
  }
`;
