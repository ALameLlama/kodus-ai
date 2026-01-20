import type {
    ContextDependency,
    ContextPack,
    LayerInputContext,
    RuntimeContextSnapshot,
} from '@kodus/flow';
import {
    createLogger,
    createOrchestration,
    createThreadId,
    PlannerType,
    StorageEnum,
} from '@kodus/flow';
import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import { DatabaseConnection } from '@libs/core/infrastructure/config/types';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BaseAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/base-agent.provider';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';

type SDKOrchestrator = Awaited<ReturnType<typeof createOrchestration>>;

interface ToolArgResolutionOutput {
    args: Record<string, unknown>;
    missingArgs: string[];
    confidence: number;
    reasoning: string;
}

interface ToolSchemaMetadata {
    description?: string;
    inputSchema?: unknown;
}

interface DependencyMetadata {
    toolName?: string;
    provider?: string;
    toolInputSchema?: ToolSchemaMetadata;
    args?: Record<string, unknown>;
    requiredArgs?: string[];
}

const ResolutionOutputSchema = z.object({
    args: z.record(z.string(), z.unknown()),
    missingArgs: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
});

const AGENT_NAME = 'mcp-tool-arg-resolver';
const TENANT_ID = 'kodus-mcp-arg-resolver';
const MODULE_NAME = 'MCPToolArgResolver';

@Injectable()
export class MCPToolArgResolverAgentService extends BaseAgentProvider {
    private readonly logger = createLogger(MCPToolArgResolverAgentService.name);
    protected config: DatabaseConnection;
    protected readonly defaultLLMConfig = {
        llmProvider: LLMModelProvider.GEMINI_2_5_FLASH,
        temperature: 0,
        maxTokens: 8000,
        maxReasoningTokens: 800,
        stop: undefined as string[] | undefined,
    };

    constructor(
        private readonly configService: ConfigService,
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
        );
        this.config =
            this.configService.get<DatabaseConnection>('mongoDatabase');
    }

    protected async createMCPAdapter(
        _organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        // No-op: este serviço não utiliza MCP adapter
    }

    private async createRequestOrchestration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<SDKOrchestrator> {
        await this.fetchBYOKConfig(organizationAndTeamData);

        // Orchestration must be created per-request to avoid state corruption in a singleton service.
        const llmAdapter = this.createLLMAdapter(MODULE_NAME, AGENT_NAME);

        const orchestration = await createOrchestration({
            tenantId: TENANT_ID,
            llmAdapter,
            observability:
                this.observabilityService.createAgentObservabilityConfig(
                    this.config,
                    'mcp-tool-arg-resolver',
                ),
            storage: {
                type: StorageEnum.MONGODB,
                connectionString:
                    this.observabilityService.buildConnectionString(
                        this.config,
                    ),
                database: this.config.database,
            },
        });

        await orchestration.createAgent({
            name: AGENT_NAME,
            enableSession: false,
            enableState: false,
            enableMemory: false,
            identity: {
                description:
                    'Specialized agent that intelligently resolves MCP tool arguments by analyzing the tool schema and available context',
                goal: 'Resolve MCP tool arguments by analyzing schemas and extracting values from available context',
            },
            plannerOptions: {
                type: PlannerType.REACT,
            },
        });

        return orchestration;
    }

    async resolveArgs(params: {
        dependency: ContextDependency;
        organizationAndTeamData?: OrganizationAndTeamData;
        pack: ContextPack;
        input: LayerInputContext;
        runtime?: RuntimeContextSnapshot;
    }): Promise<{
        args: Record<string, unknown>;
        missingArgs: string[];
        confidence: number;
    }> {
        const { dependency, organizationAndTeamData, pack, input, runtime } =
            params;

        this.logger.debug({
            message: 'resolveArgs called',
            context: 'MCPToolArgResolverAgentService',
            metadata: {
                dependencyId: dependency.id,
                dependencyType: dependency.type,
                hasMetadata: !!dependency.metadata,
            },
        });

        const metadata = this.extractMetadata(dependency);
        const toolSchema = metadata.toolInputSchema;

        // toolInputSchema já é o schema completo (pode vir como string JSON ou objeto)
        if (!toolSchema) {
            this.logger.warn({
                message: 'Tool schema not available for argument resolution',
                context: 'MCPToolArgResolverAgentService',
                metadata: {
                    toolName: metadata.toolName,
                    provider: metadata.provider,
                    organizationId: organizationAndTeamData?.organizationId,
                },
            });

            return this.getDefaultResolution(metadata);
        }

        let parsedInputSchema = toolSchema;
        if (typeof parsedInputSchema === 'string') {
            try {
                parsedInputSchema = JSON.parse(parsedInputSchema);
            } catch (error) {
                this.logger.warn({
                    message: 'Failed to parse toolInputSchema as JSON',
                    context: 'MCPToolArgResolverAgentService',
                    metadata: {
                        toolName: metadata.toolName,
                        provider: metadata.provider,
                        errorMessage:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });

                return this.getDefaultResolution(metadata);
            }
        }

        // Valida se o objeto parseado tem conteúdo válido
        if (
            typeof parsedInputSchema !== 'object' ||
            parsedInputSchema === null ||
            Array.isArray(parsedInputSchema) ||
            Object.keys(parsedInputSchema).length === 0
        ) {
            this.logger.warn({
                message: 'Tool schema is invalid or empty',
                context: 'MCPToolArgResolverAgentService',
                metadata: {
                    toolName: metadata.toolName,
                    provider: metadata.provider,
                    organizationId: organizationAndTeamData?.organizationId,
                    parsedInputSchemaType: typeof parsedInputSchema,
                },
            });

            return this.getDefaultResolution(metadata);
        }

        const logContext = {
            toolName: metadata.toolName,
            provider: metadata.provider,
            organizationId: organizationAndTeamData?.organizationId,
        };

        if (!organizationAndTeamData) {
            this.logger.warn({
                message: 'Organization and team data is required',
                context: 'MCPToolArgResolverAgentService',
                metadata: logContext,
            });

            return this.getDefaultResolution(metadata);
        }

        try {
            const orchestration = await this.createRequestOrchestration(
                organizationAndTeamData,
            );

            this.logger.debug({
                message: 'Orchestration created, building prompt',
                context: 'MCPToolArgResolverAgentService',
                metadata: logContext,
            });

            const prompt = this.buildPrompt(
                metadata.toolName || 'unknown',
                undefined, // toolSchema não tem description separada
                this.safeStringify(parsedInputSchema),
                this.safeStringify({
                    organization: organizationAndTeamData,
                    pack,
                    input,
                    runtime,
                }),
                metadata.args
                    ? this.safeStringify(metadata.args)
                    : 'None provided',
            );

            this.logger.debug({
                message: 'Prompt built successfully',
                context: 'MCPToolArgResolverAgentService',
                metadata: {
                    ...logContext,
                    promptLength: prompt.length,
                },
            });

            const thread = createThreadId(
                {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    toolName: metadata.toolName || 'unknown',
                    provider: metadata.provider || 'unknown',
                },
                {
                    prefix: 'mcp',
                },
            );

            this.logger.log({
                message: 'Calling agent to resolve tool arguments',
                context: 'MCPToolArgResolverAgentService',
                metadata: {
                    ...logContext,
                    threadId: thread.id,
                    promptLength: prompt.length,
                },
            });

            const result = await orchestration.callAgent(AGENT_NAME, prompt, {
                thread,
                userContext: { organizationAndTeamData },
            });

            this.logger.log({
                message: 'Agent response received',
                context: 'MCPToolArgResolverAgentService',
                metadata: {
                    ...logContext,
                    resultType: typeof result.result,
                    hasResult: !!result.result,
                    resultPreview: String(result.result).substring(0, 200),
                },
            });

            return this.processAgentResponse(
                result.result,
                metadata,
                logContext,
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to resolve arguments using agent',
                context: 'MCPToolArgResolverAgentService',
                error,
                metadata: {
                    ...logContext,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                },
            });

            return this.getDefaultResolution(metadata);
        }
    }

    private processAgentResponse(
        response: unknown,
        metadata: DependencyMetadata,
        logContext: {
            toolName?: string;
            provider?: string;
            organizationId?: string;
        },
    ): {
        args: Record<string, unknown>;
        missingArgs: string[];
        confidence: number;
    } {
        const parsed = this.parseAgentResponse(response);
        if (!parsed) {
            this.logger.warn({
                message: 'Failed to parse agent response as JSON',
                context: 'MCPToolArgResolverAgentService',
                metadata: {
                    ...logContext,
                    rawResponse: String(response).substring(0, 500),
                },
            });

            return this.getDefaultResolution(metadata);
        }

        const validated = ResolutionOutputSchema.safeParse(parsed);
        if (!validated.success) {
            this.logger.error({
                message: 'Agent returned invalid output schema',
                context: 'MCPToolArgResolverAgentService',
                error: validated.error,
                metadata: {
                    ...logContext,
                    parsedOutput: this.safeStringify(parsed).substring(0, 500),
                },
            });

            return this.getDefaultResolution(metadata);
        }

        this.logger.debug({
            message: 'Successfully resolved tool arguments using agent',
            context: 'MCPToolArgResolverAgentService',
            metadata: {
                ...logContext,
                confidence: validated.data.confidence,
                missingArgs: validated.data.missingArgs,
                resolvedArgsCount: Object.keys(validated.data.args).length,
            },
        });

        return {
            args: validated.data.args,
            missingArgs: validated.data.missingArgs,
            confidence: validated.data.confidence,
        };
    }

    private extractMetadata(dependency: ContextDependency): DependencyMetadata {
        return (dependency.metadata as DependencyMetadata) ?? {};
    }

    private safeStringify(value: unknown): string {
        try {
            return JSON.stringify(value);
        } catch (error) {
            this.logger.warn({
                message: 'Failed to stringify value, using fallback',
                context: 'MCPToolArgResolverAgentService',
                metadata: {
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                },
            });

            // Fallback para valores que não podem ser serializados
            return String(value);
        }
    }

    private buildPrompt(
        toolName: string,
        toolDescription: string | undefined,
        schemaStr: string,
        contextStr: string,
        partialArgsStr: string,
    ): string {
        return `You are a specialized tool argument resolver. Your task is to analyze an MCP tool schema and fill in missing required arguments using the available context.

**Tool Information:**
- Name: ${toolName}
- Description: ${toolDescription || 'No description provided'}
- Input Schema:
\`\`\`json
${schemaStr}
\`\`\`

**Available Context:**
\`\`\`json
${contextStr}
\`\`\`

**Partially Provided Arguments:**
\`\`\`json
${partialArgsStr}
\`\`\`

**Your Task:**
1. Analyze the input schema to identify ALL required arguments
2. Check which arguments are already provided in partialArgs
3. Use the available context to intelligently fill in missing required arguments
4. Extract values from context using common patterns:
   - organizationId → context.organization.organizationId
   - teamId → context.organization.teamId
   - repositoryId → context.pack.metadata.repositoryId or context.input.retrieval...
   - contextReferenceId → context.pack.metadata.contextReferenceId
   - etc.

**Important Rules:**
- Only fill arguments that are REQUIRED by the schema
- Use the most appropriate value from context
- If a required argument cannot be inferred from context, mark it as missing
- Return a confidence score (0-1) indicating how confident you are in the resolution
- Provide clear reasoning for your choices

**Output Format:**
Return ONLY a valid JSON object with this exact structure:
{
  "args": { /* all resolved arguments */ },
  "missingArgs": [ /* array of argument names that couldn't be resolved */ ],
  "confidence": 0.95, /* confidence score 0-1 */
  "reasoning": "Explanation of how you resolved each argument"
}`;
    }

    private parseAgentResponse(
        response: unknown,
    ): ToolArgResolutionOutput | null {
        try {
            const responseStr =
                typeof response === 'string'
                    ? response
                    : JSON.stringify(response);

            // Extract JSON from response (might have markdown code blocks)
            // Use safe extraction to avoid regex backtracking DoS
            let jsonStr = responseStr;

            // Try to extract from ```json blocks first
            const jsonBlockStart = responseStr.indexOf('```json');
            if (jsonBlockStart !== -1) {
                const jsonBlockEnd = responseStr.indexOf(
                    '```',
                    jsonBlockStart + 7,
                );
                if (jsonBlockEnd !== -1) {
                    jsonStr = responseStr
                        .substring(jsonBlockStart + 7, jsonBlockEnd)
                        .trim();
                }
            } else {
                // Try generic ``` blocks
                const genericBlockStart = responseStr.indexOf('```');
                if (genericBlockStart !== -1) {
                    const nextNewline = responseStr.indexOf(
                        '\n',
                        genericBlockStart + 3,
                    );
                    const contentStart =
                        nextNewline !== -1
                            ? nextNewline + 1
                            : genericBlockStart + 3;
                    const genericBlockEnd = responseStr.indexOf(
                        '```',
                        contentStart,
                    );
                    if (genericBlockEnd !== -1) {
                        jsonStr = responseStr
                            .substring(contentStart, genericBlockEnd)
                            .trim();
                    }
                }
            }

            return JSON.parse(jsonStr.trim()) as ToolArgResolutionOutput;
        } catch (error) {
            this.logger.debug({
                message: 'Failed to parse agent response',
                context: 'MCPToolArgResolverAgentService',
                metadata: {
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                    responseType: typeof response,
                    responsePreview:
                        typeof response === 'string'
                            ? response.substring(0, 200)
                            : String(response).substring(0, 200),
                },
            });

            return null;
        }
    }

    private getDefaultResolution(metadata: DependencyMetadata): {
        args: Record<string, unknown>;
        missingArgs: string[];
        confidence: number;
    } {
        return {
            args: metadata.args || {},
            missingArgs: metadata.requiredArgs || [],
            confidence: 0,
        };
    }
}
