// GENERATED FILE — DO NOT EDIT BY HAND.
// Source: https://opencode.ai/config.json
// Fetched: 2026-09-04T15:55:01.073Z · sha256: e8cb6e287a3852ee3403f4803be5ad6b19db94948037eaa9672125c333427922
// Regenerate: pnpm exec tsx tools/gen-schema.ts && pnpm exec prettier --write shared/schema.generated.ts
// Policy: permissive passthrough (unknown keys never rejected — SCW-7/CX-4);
// required/enum constraints intentionally dropped to avoid false rejects.
import { z } from 'zod';

const def_LogLevel: z.ZodTypeAny = z.string();
const def_ServerConfig: z.ZodTypeAny = z
  .object({
    port: z.number().optional(),
    hostname: z.string().optional(),
    mdns: z.boolean().optional(),
    mdnsDomain: z.string().optional(),
    cors: z.array(z.string()).optional(),
  })
  .passthrough();
const def_ConfigV2_Reference_Git: z.ZodTypeAny = z
  .object({
    repository: z.string().optional(),
    branch: z.string().optional(),
    description: z.string().optional(),
    hidden: z.boolean().optional(),
  })
  .passthrough();
const def_ConfigV2_Reference_Local: z.ZodTypeAny = z
  .object({
    path: z.string().optional(),
    description: z.string().optional(),
    hidden: z.boolean().optional(),
  })
  .passthrough();
const def_PermissionActionConfig: z.ZodTypeAny = z.string();
const def_PermissionObjectConfig: z.ZodTypeAny = z.record(
  z.string(),
  z.lazy(() => def_PermissionActionConfig),
);
const def_PermissionRuleConfig: z.ZodTypeAny = z.union([
  z.lazy(() => def_PermissionActionConfig),
  z.lazy(() => def_PermissionObjectConfig),
]);
const def_PermissionConfig: z.ZodTypeAny = z.union([
  z.lazy(() => def_PermissionActionConfig),
  z.intersection(
    z
      .object({
        read: z.lazy(() => def_PermissionRuleConfig).optional(),
        edit: z.lazy(() => def_PermissionRuleConfig).optional(),
        glob: z.lazy(() => def_PermissionRuleConfig).optional(),
        grep: z.lazy(() => def_PermissionRuleConfig).optional(),
        list: z.lazy(() => def_PermissionRuleConfig).optional(),
        bash: z.lazy(() => def_PermissionRuleConfig).optional(),
        task: z.lazy(() => def_PermissionRuleConfig).optional(),
        external_directory: z.lazy(() => def_PermissionRuleConfig).optional(),
        todowrite: z.lazy(() => def_PermissionActionConfig).optional(),
        question: z.lazy(() => def_PermissionActionConfig).optional(),
        webfetch: z.lazy(() => def_PermissionActionConfig).optional(),
        websearch: z.lazy(() => def_PermissionActionConfig).optional(),
        lsp: z.lazy(() => def_PermissionRuleConfig).optional(),
        doom_loop: z.lazy(() => def_PermissionActionConfig).optional(),
        skill: z.lazy(() => def_PermissionRuleConfig).optional(),
      })
      .passthrough(),
    z.record(
      z.string(),
      z.lazy(() => def_PermissionRuleConfig),
    ),
  ),
]);
const def_AgentConfig: z.ZodTypeAny = z
  .object({
    model: z.unknown().optional(),
    variant: z.string().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    prompt: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    disable: z.boolean().optional(),
    description: z.string().optional(),
    mode: z.string().optional(),
    hidden: z.boolean().optional(),
    options: z.object({}).passthrough().optional(),
    color: z.union([z.string(), z.string()]).optional(),
    steps: z.number().optional(),
    maxSteps: z.number().optional(),
    permission: z.lazy(() => def_PermissionConfig).optional(),
  })
  .passthrough();
const def_ProviderConfig: z.ZodTypeAny = z
  .object({
    api: z.string().optional(),
    name: z.string().optional(),
    env: z.array(z.string()).optional(),
    id: z.string().optional(),
    npm: z.string().optional(),
    whitelist: z.array(z.string()).optional(),
    blacklist: z.array(z.string()).optional(),
    options: z
      .object({
        apiKey: z.string().optional(),
        baseURL: z.string().optional(),
        enterpriseUrl: z.string().optional(),
        setCacheKey: z.boolean().optional(),
        timeout: z.union([z.number(), z.boolean()]).optional(),
        headerTimeout: z.union([z.number(), z.boolean()]).optional(),
        chunkTimeout: z.union([z.number(), z.boolean()]).optional(),
      })
      .passthrough()
      .optional(),
    models: z
      .record(
        z.string(),
        z
          .object({
            id: z.string().optional(),
            name: z.string().optional(),
            family: z.string().optional(),
            release_date: z.string().optional(),
            attachment: z.boolean().optional(),
            reasoning: z.boolean().optional(),
            temperature: z.boolean().optional(),
            tool_call: z.boolean().optional(),
            interleaved: z
              .union([
                z.boolean(),
                z.union([z.string(), z.string()]),
                z
                  .object({
                    field: z.union([z.string(), z.string()]).optional(),
                  })
                  .passthrough(),
              ])
              .optional(),
            cost: z
              .object({
                input: z.number().optional(),
                output: z.number().optional(),
                cache_read: z.number().optional(),
                cache_write: z.number().optional(),
                context_over_200k: z
                  .object({
                    input: z.number().optional(),
                    output: z.number().optional(),
                    cache_read: z.number().optional(),
                    cache_write: z.number().optional(),
                  })
                  .passthrough()
                  .optional(),
              })
              .passthrough()
              .optional(),
            limit: z
              .object({
                context: z.number().optional(),
                input: z.number().optional(),
                output: z.number().optional(),
              })
              .passthrough()
              .optional(),
            modalities: z
              .object({
                input: z.array(z.string()).optional(),
                output: z.array(z.string()).optional(),
              })
              .passthrough()
              .optional(),
            experimental: z.boolean().optional(),
            status: z.string().optional(),
            provider: z
              .object({
                npm: z.string().optional(),
                api: z.string().optional(),
              })
              .passthrough()
              .optional(),
            options: z.object({}).passthrough().optional(),
            headers: z.record(z.string(), z.string()).optional(),
            variants: z
              .record(
                z.string(),
                z.object({ disabled: z.boolean().optional() }).passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const def_McpLocalConfig: z.ZodTypeAny = z
  .object({
    type: z.string().optional(),
    command: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    environment: z.record(z.string(), z.string()).optional(),
    enabled: z.boolean().optional(),
    timeout: z.number().optional(),
  })
  .passthrough();
const def_McpOAuthConfig: z.ZodTypeAny = z
  .object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    scope: z.string().optional(),
    callbackPort: z.number().optional(),
    redirectUri: z.string().optional(),
  })
  .passthrough();
const def_McpRemoteConfig: z.ZodTypeAny = z
  .object({
    type: z.string().optional(),
    url: z.string().optional(),
    enabled: z.boolean().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z.union([z.lazy(() => def_McpOAuthConfig), z.boolean()]).optional(),
    timeout: z.number().optional(),
  })
  .passthrough();
const def_LayoutConfig: z.ZodTypeAny = z.string();
const def_ImageAttachmentConfig: z.ZodTypeAny = z
  .object({
    auto_resize: z.boolean().optional(),
    max_width: z.number().optional(),
    max_height: z.number().optional(),
    max_base64_bytes: z.number().optional(),
  })
  .passthrough();
const def_AttachmentConfig: z.ZodTypeAny = z
  .object({ image: z.lazy(() => def_ImageAttachmentConfig).optional() })
  .passthrough();
const def_Policy_Effect: z.ZodTypeAny = z.string();
const def_ConfigV2_Experimental_Policy: z.ZodTypeAny = z
  .object({
    action: z.string().optional(),
    effect: z.lazy(() => def_Policy_Effect).optional(),
    resource: z.string().optional(),
  })
  .passthrough();
const def_Config: z.ZodTypeAny = z
  .object({
    $schema: z.string().optional(),
    shell: z.string().optional(),
    logLevel: z.lazy(() => def_LogLevel).optional(),
    server: z.lazy(() => def_ServerConfig).optional(),
    command: z
      .record(
        z.string(),
        z
          .object({
            template: z.string().optional(),
            description: z.string().optional(),
            agent: z.string().optional(),
            model: z.unknown().optional(),
            variant: z.string().optional(),
            subtask: z.boolean().optional(),
          })
          .passthrough(),
      )
      .optional(),
    skills: z
      .object({
        paths: z.array(z.string()).optional(),
        urls: z.array(z.string()).optional(),
      })
      .passthrough()
      .optional(),
    references: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.lazy(() => def_ConfigV2_Reference_Git),
          z.lazy(() => def_ConfigV2_Reference_Local),
        ]),
      )
      .optional(),
    reference: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.lazy(() => def_ConfigV2_Reference_Git),
          z.lazy(() => def_ConfigV2_Reference_Local),
        ]),
      )
      .optional(),
    watcher: z
      .object({ ignore: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    snapshot: z.boolean().optional(),
    plugin: z.array(z.union([z.string(), z.array(z.unknown())])).optional(),
    share: z.string().optional(),
    autoshare: z.boolean().optional(),
    autoupdate: z.union([z.boolean(), z.string()]).optional(),
    disabled_providers: z.array(z.string()).optional(),
    enabled_providers: z.array(z.string()).optional(),
    model: z.unknown().optional(),
    small_model: z.unknown().optional(),
    default_agent: z.string().optional(),
    subagent_depth: z.number().optional(),
    username: z.string().optional(),
    mode: z
      .intersection(
        z
          .object({
            build: z.lazy(() => def_AgentConfig).optional(),
            plan: z.lazy(() => def_AgentConfig).optional(),
          })
          .passthrough(),
        z.record(
          z.string(),
          z.lazy(() => def_AgentConfig),
        ),
      )
      .optional(),
    agent: z
      .intersection(
        z
          .object({
            plan: z.lazy(() => def_AgentConfig).optional(),
            build: z.lazy(() => def_AgentConfig).optional(),
            general: z.lazy(() => def_AgentConfig).optional(),
            explore: z.lazy(() => def_AgentConfig).optional(),
            title: z.lazy(() => def_AgentConfig).optional(),
            summary: z.lazy(() => def_AgentConfig).optional(),
            compaction: z.lazy(() => def_AgentConfig).optional(),
          })
          .passthrough(),
        z.record(
          z.string(),
          z.lazy(() => def_AgentConfig),
        ),
      )
      .optional(),
    provider: z
      .record(
        z.string(),
        z.lazy(() => def_ProviderConfig),
      )
      .optional(),
    mcp: z
      .record(
        z.string(),
        z.union([
          z.union([
            z.lazy(() => def_McpLocalConfig),
            z.lazy(() => def_McpRemoteConfig),
          ]),
          z.object({ enabled: z.boolean().optional() }).passthrough(),
        ]),
      )
      .optional(),
    formatter: z
      .union([
        z.boolean(),
        z.record(
          z.string(),
          z
            .object({
              disabled: z.boolean().optional(),
              command: z.array(z.string()).optional(),
              environment: z.record(z.string(), z.string()).optional(),
              extensions: z.array(z.string()).optional(),
            })
            .passthrough(),
        ),
      ])
      .optional(),
    lsp: z
      .union([
        z.boolean(),
        z.record(
          z.string(),
          z.union([
            z.object({ disabled: z.boolean().optional() }).passthrough(),
            z
              .object({
                command: z.array(z.string()).optional(),
                extensions: z.array(z.string()).optional(),
                disabled: z.boolean().optional(),
                env: z.record(z.string(), z.string()).optional(),
                initialization: z.object({}).passthrough().optional(),
              })
              .passthrough(),
          ]),
        ),
      ])
      .optional(),
    instructions: z.array(z.string()).optional(),
    layout: z.lazy(() => def_LayoutConfig).optional(),
    permission: z.lazy(() => def_PermissionConfig).optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    attachment: z.lazy(() => def_AttachmentConfig).optional(),
    enterprise: z
      .object({ url: z.string().optional() })
      .passthrough()
      .optional(),
    tool_output: z
      .object({
        max_lines: z.number().optional(),
        max_bytes: z.number().optional(),
      })
      .passthrough()
      .optional(),
    compaction: z
      .object({
        auto: z.boolean().optional(),
        prune: z.boolean().optional(),
        tail_turns: z.number().optional(),
        preserve_recent_tokens: z.number().optional(),
        reserved: z.number().optional(),
      })
      .passthrough()
      .optional(),
    experimental: z
      .object({
        disable_paste_summary: z.boolean().optional(),
        batch_tool: z.boolean().optional(),
        openTelemetry: z.boolean().optional(),
        primary_tools: z.array(z.string()).optional(),
        continue_loop_on_deny: z.boolean().optional(),
        mcp_timeout: z.number().optional(),
        policies: z
          .array(z.lazy(() => def_ConfigV2_Experimental_Policy))
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const configSchema: z.ZodTypeAny = z.lazy(() => def_Config);
