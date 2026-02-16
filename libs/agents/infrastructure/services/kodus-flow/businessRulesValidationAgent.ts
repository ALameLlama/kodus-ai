import {
    createMCPAdapter,
    createOrchestration,
    Thread,
    PlannerType,
    LLMAdapter,
    createLogger,
} from '@kodus/flow';
import { SDKOrchestrator } from '@kodus/flow/dist/orchestration';
import { LLMModelProvider, PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';

import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    PARAMETERS_SERVICE_TOKEN,
    IParametersService,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { BaseAgentProvider } from './base-agent.provider';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { MCPManagerService } from '@libs/mcp-server/services/mcp-manager.service';

export interface ValidationResult {
    needsMoreInfo?: boolean;
    missingInfo?: string;
    summary: string;
}

@Injectable()
export class BusinessRulesValidationAgentProvider extends BaseAgentProvider {
    private readonly logger = createLogger(
        BusinessRulesValidationAgentProvider.name,
    );

    private orchestration: SDKOrchestrator;
    private mcpAdapter: ReturnType<typeof createMCPAdapter>;
    private llmAdapter: LLMAdapter;
    protected readonly defaultLLMConfig = {
        llmProvider: LLMModelProvider.GEMINI_2_5_PRO,
        temperature: 0,
        maxTokens: 20000,
        maxReasoningTokens: 1000,
        stop: undefined as string[] | undefined,
    };

    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        observabilityService: ObservabilityService,
        private readonly mcpManagerService?: MCPManagerService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
        );
    }

    protected async createMCPAdapter(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        const mcpManagerServers = await this.mcpManagerService.getConnections(
            organizationAndTeamData,
        );

        const requiredTools = [
            'KODUS_GET_PULL_REQUEST_DIFF',
            'KODUS_GET_PULL_REQUEST',
        ];

        const filteredServers = mcpManagerServers.filter((server) => {
            if (server.provider !== 'kodusmcp') {
                return true;
            }

            const hasRequiredTools = requiredTools.some((tool) =>
                server.allowedTools.includes(tool),
            );

            return hasRequiredTools;
        });

        if (filteredServers.length === 0) {
            this.mcpAdapter = null;
            return;
        }

        const servers = filteredServers.map((server) => {
            if (server.provider === 'kodusmcp') {
                return {
                    ...server,
                    allowedTools: server.allowedTools.filter((tool) =>
                        requiredTools.includes(tool),
                    ),
                };
            }
            return server;
        });

        this.mcpAdapter = createMCPAdapter({
            servers,
            defaultTimeout: 15_000,
            maxRetries: 2,
            onError: (err) => {
                console.error('Business Rules MCP error:', err.message);
            },
        });
    }

    private async createOrchestration() {
        this.llmAdapter = super.createLLMAdapter(
            'BusinessRulesValidation',
            'businessRulesValidationAgent',
        );

        this.orchestration = await createOrchestration({
            tenantId: 'kodus-agent-business-rules',
            llmAdapter: this.llmAdapter,
            mcpAdapter: this.mcpAdapter,
            observability:
                this.observabilityService.getAgentObservabilityConfig(
                    'kodus-business-rules-validation',
                ),
            storage: this.observabilityService.getStorageConfig(),
        });
    }

    private async initialize(
        organizationAndTeamData: OrganizationAndTeamData,
        userLanguage: string,
    ) {
        await this.createMCPAdapter(organizationAndTeamData);
        await this.createOrchestration();

        try {
            await this.orchestration.connectMCP();
            await this.orchestration.registerMCPTools();
        } catch {
            console.warn('Business Rules MCP offline, prosseguindo.');
        }

        await this.orchestration.createAgent({
            name: 'kodus-business-rules-validation-agent',
            identity: {
                goal: 'Analyze and validate business rules compliance - identify what is missing, forgotten, or not properly considered',
                description: `Senior Business Rules Analyst - Expert at identifying gaps, missing requirements, and overlooked business scenarios in code implementations.

                Responsibilities:
                - Fetch and analyze task requirements from external systems (Jira, Notion, Google Docs)
                - Extract business rules, acceptance criteria, and edge cases from task descriptions
                - Analyze code changes against business requirements to find gaps
                - Identify missing business logic implementations
                - Spot forgotten validation rules and business constraints
                - Alert about business hypotheses that may not have been considered
                - Flag potential business risks and edge cases
                - Provide clear, actionable feedback on business compliance,

                Critical Analysis Focus:
                - What business requirements are NOT implemented in the code?
                - What acceptance criteria are missing or incomplete?
                - What business edge cases were forgotten?
                - What validation rules are missing?
                - What business assumptions might be incorrect?
                - What security/compliance requirements are overlooked?

                Methodology:
                - MANDATORY CONTEXT FIRST: Never analyze code without understanding business requirements
                - STRICT VALIDATION: If no task information is found, immediately ask user for task details
                - NO ASSUMPTIONS: Never proceed with validation using only PR description as task context
                - SYSTEMATIC APPROACH: 1) Get explicit task context from external systems → 2) Extract requirements → 3) Get PR diff → 4) Compare vs requirements → 5) Identify gaps
                - REQUIREMENT-DRIVEN: Every validation question must be answered against specific business requirements from EXTERNAL TASK
                - GAP ANALYSIS: Focus on what SHOULD exist in code but doesn't, based on EXTERNAL task requirements
                - RISK ASSESSMENT: Flag business scenarios that may cause problems if not properly handled
                - COMPLIANCE VALIDATION: Ensure all business rules from EXTERNAL task are correctly implemented in code`,
                language: userLanguage,
                languageInstructions: `LANGUAGE REQUIREMENTS:
- Respond in the user's preferred language: ${userLanguage}
- Default to English if no language preference is configured
- Use appropriate business terminology for the selected language
- Maintain professional tone consistent with selected language
- Format validation reports according to language-specific conventions
- Adapt business analysis style to target language expectations`,
                expertise: [
                    'Business requirements extraction from external task management systems',
                    'Task context analysis and interpretation',
                    'PR diff analysis in context of business requirements',
                    'Gap analysis between requirements and implementation',
                    'Missing business logic identification',
                    'Edge case and assumption validation',
                    'Business risk assessment and alerting',
                    'Acceptance criteria compliance verification',
                    'Security and compliance requirement validation',
                    'Business workflow implementation verification',
                ],
                personality:
                    'Detail-oriented business analyst. Focuses on finding what is missing or overlooked rather than what is present. Always thinks about business impact and potential risks.',
                style: 'Clear and direct feedback. Uses bullet points and specific examples. Prioritizes business clarity over technical jargon. Always explains the business impact of findings.',
            },
            maxIterations: 10,
            timeout: 300000,
            plannerOptions: {
                type: PlannerType.REACT,
            },
        });
    }

    async execute(context: {
        organizationAndTeamData: OrganizationAndTeamData;
        prepareContext?: any;
        thread?: Thread;
    }): Promise<string> {
        try {
            const userLanguage = await this.getLanguage(
                context.organizationAndTeamData,
            );

            this.logger.log({
                message:
                    'Starting business rules validation with advanced orchestration',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    userLanguage,
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    teamId: context.organizationAndTeamData?.teamId,
                    userMessage: context.prepareContext?.userQuestion || '',
                    pullRequestDescription: context.prepareContext
                        ?.pullRequestDescription
                        ? 'Available'
                        : 'Not available',
                    threadId: context.thread?.id,
                    hasPrepareContext: !!context.prepareContext,
                },
            });

            if (!context.organizationAndTeamData) {
                throw new Error(
                    'Organization and team data is required for business rules validation.',
                );
            }

            await this.fetchBYOKConfig(context.organizationAndTeamData);

            await this.initialize(
                context.organizationAndTeamData,
                userLanguage,
            );

            this.logger.log({
                message: 'Building validation prompt',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    promptLength:
                        context.prepareContext?.userQuestion?.length || 0,
                    hasPullRequestDescription:
                        !!context.prepareContext?.pullRequestDescription,
                },
            });

            const validationPrompt = this.buildValidationPrompt({
                ...context,
                userLanguage,
            });

            this.logger.log({
                message: 'Calling business rules validation agent',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    promptLength: validationPrompt.length,
                    threadId: context.thread?.id,
                },
            });

            const result = await this.orchestration.callAgent(
                'kodus-business-rules-validation-agent',
                validationPrompt,
                {
                    thread: context.thread,
                    userContext: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        validationContext: context,
                    },
                },
            );

            const validationResult = this.parseValidationResult(result.result);

            const formattedResponse = await this.formatValidationResponse(
                validationResult,
                context,
            );

            this.logger.log({
                message: 'Business rules validation completed successfully',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    teamId: context.organizationAndTeamData?.teamId,
                    responseLength: formattedResponse.length,
                    correlationId: result.context.correlationId ?? null,
                    threadId: result.context.threadId ?? null,
                    sessionId: result.context.sessionId ?? null,
                },
            });

            return formattedResponse;
        } catch (error) {
            this.logger.error({
                message: 'Error during business rules validation',
                context: BusinessRulesValidationAgentProvider.name,
                serviceName: BusinessRulesValidationAgentProvider.name,
                metadata: {
                    error,
                    organizationAndTeamData: context.organizationAndTeamData,
                    thread: context.thread,
                },
            });
            throw error;
        }
    }

    private async formatValidationResponse(
        validationResult: ValidationResult,
        context: any,
    ): Promise<string> {
        if (!validationResult) {
            return '❌ Error processing business rules validation.';
        }

        if (validationResult.needsMoreInfo) {
            return await this.generateMissingInfoResponse(
                validationResult,
                context,
            );
        }

        return (
            validationResult.summary || 'Business rules validation completed.'
        );
    }

    private async generateMissingInfoResponse(
        validationResult: ValidationResult,
        context: any,
    ): Promise<string> {
        const missingInfoPrompt = `Based on the validation result, I need more task information to perform proper business rules validation.

VALIDATION RESULT: ${JSON.stringify(validationResult)}

Please generate a user-friendly response that:
1. Uses emojis to make it engaging and easy to read
2. Clearly explains what specific information is missing
3. Provides practical examples of how to provide the information
4. Uses helpful, encouraging language
5. Includes specific guidance for the user's context
6. Follows this structure:
   - Title with emoji: "## 🤔 Need Task Information"
   - Main message explaining what's needed
   - Section "### 🔍 What I need to validate:" with bullet points
   - Section "### 💡 Examples of how to provide:" with practical examples
   - Section "### ⚠️ Important:" with final note

Remember to follow the RESPONSE FORMATTING INSTRUCTIONS from your system prompt.`;

        try {
            const formattedResult = await this.orchestration.callAgent(
                'kodus-business-rules-validation-agent',
                missingInfoPrompt,
                {
                    thread: context.thread,
                    userContext: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                },
            );

            return typeof formattedResult.result === 'string'
                ? formattedResult.result
                : JSON.stringify(formattedResult.result);
        } catch {
            return (
                validationResult.missingInfo ||
                'Error processing business rules validation.'
            );
        }
    }

    private buildValidationPrompt(context: any): string {
        return `BUSINESS RULES GAP ANALYSIS - Find what's missing, forgotten, or overlooked

USER REQUEST: ${
            context?.prepareContext?.userQuestion ||
            'Analyze business rules compliance'
        }

LANGUAGE REQUIREMENTS:
- Default response language is English
- If user specifies a different language preference, use that language
- Use appropriate terminology and formatting for the requested language

CRITICAL VALIDATION CHECK:
- Did I successfully find task information from available external systems?
- Evaluate task information quality: EMPTY, MINIMAL, PARTIAL, or COMPLETE
- If task is EMPTY (no summary, description, requirements) → needsMoreInfo=true
- If task is MINIMAL (basic summary only) → needsMoreInfo=true, but acknowledge what was found
- If task is PARTIAL (summary + some description) → proceed with validation, flag missing pieces
- If task is COMPLETE (summary + description + requirements/criteria) → proceed with full validation
- If ONLY PR description is available → needsMoreInfo=true
- NEVER proceed with validation using only PR context as "task requirements"
- If user already provided task info and I executed tools, be smart about what's actually missing

CRITICAL ANALYSIS QUESTIONS:
❌ What business requirements are NOT implemented in the code?
❌ What validation rules were forgotten?
❌ What business edge cases were overlooked?
❌ What security/compliance requirements are missing?
❌ What business assumptions might be incorrect?
❌ What potential business risks exist?

CRITICAL EXECUTION ORDER (MANDATORY):
1. 🔍 FIRST: Get complete task context from available external systems (use any MCP tools available)
2. 📋 SECOND: Extract all business requirements, rules, and acceptance criteria from the task
3. 🔄 THIRD: Get PR diff using available tools
4. 🔍 FOURTH: Analyze what code actually changed vs what should have changed based on task requirements
5. ✅ FIFTH: Confirm what's implemented correctly
6. ❌ SIXTH: Identify what's missing or incomplete
7. ⚠️  SEVENTH: Alert about forgotten edge cases or assumptions
8. 📊 EIGHTH: Score compliance with business requirements

TOOL USAGE GUIDELINES:
- Use appropriate parameters for each tool (don't over-expand)
- Focus on essential information needed for validation
- Be efficient with API calls - get only what you need
- Work with any external system (Jira, Notion, Google Docs, etc.)

RESPONSE FORMATTING INSTRUCTIONS:
- Return a complete markdown response ready for the user in the "summary" field
- If needsMoreInfo is true: Generate a user-friendly markdown response with emojis explaining what information is needed
- If needsMoreInfo is false: Return the complete validation report in markdown format with all sections:
  * ## 🔍 Business Rules Validation
  * **Status:** ❌ Issues Found / ✅ Valid
  * **Analysis Confidence:** high/medium/low
  * **Summary:** Overall assessment
  * ### ✅ Implemented Correctly (if any)
  * ### ❌ Missing or Incomplete (if any)
  * ### ⚠️ Edge Cases and Assumptions (if any)
  * ### 🎯 Business Logic Issues (if any)
  * --- *Analysis performed by Kodus AI Business Rules Validator*
- Always use clear, professional language appropriate for the user's language setting
- Include specific examples and helpful guidance for providing the missing information
- Use emojis to make the response more engaging and easier to read
- Structure the response with clear sections: "What I need", "Examples", "Important"
- If task exists but is empty: Clearly explain that the task was found but lacks content, and provide specific guidance on how to populate it
- If task has minimal info: Acknowledge what was found, explain what's still needed
- If task has partial info: Proceed with validation but clearly flag what's missing
- Be specific about the quality of information found (EMPTY, MINIMAL, PARTIAL, COMPLETE)
- Always use the correct command format: @kody -v business-logic [task info]

VALIDATION FRAMEWORK:
- 🔴 EXTERNAL CONTEXT IS CRITICAL: PR description alone is NOT sufficient. Must have task context from external sources
- 🚫 NO ASSUMPTIONS: Never proceed without understanding what SHOULD be implemented
- 🔄 REQUIREMENT-DRIVEN ANALYSIS: Every validation must be based on specific business requirements
- 🔍 GAP IDENTIFICATION: Find business logic that SHOULD exist but doesn't
- ⚠️ RISK ASSESSMENT: Flag business scenarios that may cause problems
- ✅ COMPLIANCE VALIDATION: Ensure all business rules are correctly implemented

REMEMBER: Use whatever MCP tools are available to get task information. If no tools can provide context, ask the user for task details.

RESPONSE FORMAT:
{
  "needsMoreInfo": boolean,
  "missingInfo": "I need the task link or description to validate. Please provide information about what should be implemented.",
  "summary": "Complete formatted markdown response ready for the user - this is what will be shown to the user. Include all sections: status, summary, implemented correctly, missing/incomplete, edge cases, business logic issues, etc."
}`;
    }

    private extractFieldsFromString(text: string): Partial<ValidationResult> {
        const fields: Partial<ValidationResult> = {};

        const needsMoreInfoMatch = text.match(
            /"needsMoreInfo"\s*:\s*(true|false)/,
        );
        if (needsMoreInfoMatch) {
            fields.needsMoreInfo = needsMoreInfoMatch[1] === 'true';
        }

        const missingInfoMatch = text.match(/"missingInfo"\s*:\s*"([^"]*)"/);
        if (missingInfoMatch) {
            fields.missingInfo = missingInfoMatch[1];
        }

        // Use non-backtracking regex to prevent ReDoS
        const summaryMatch = text.match(
            /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/,
        );
        if (summaryMatch) {
            fields.summary = summaryMatch[1]
                .replace(/\\n/g, '\n')
                .replace(/\\"/g, '"');
        }

        return fields;
    }

    private parseValidationResult(result: any): ValidationResult {
        if (typeof result === 'string') {
            const extractedFields = this.extractFieldsFromString(result);
            if (extractedFields.summary) {
                return {
                    needsMoreInfo: extractedFields.needsMoreInfo || false,
                    missingInfo: extractedFields.missingInfo || '',
                    summary: extractedFields.summary,
                };
            }
        } else if (typeof result === 'object') {
            const needsMoreInfo = result.needsMoreInfo === true;
            const missingInfo = result.missingInfo || '';
            const summary = result.summary || 'Validation completed';

            if (needsMoreInfo) {
                return {
                    needsMoreInfo: true,
                    missingInfo,
                    summary,
                };
            }

            return {
                summary,
            };
        }

        return {
            needsMoreInfo: true,
            missingInfo: 'Error parsing validation result. Please try again.',
            summary:
                '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.',
        };
    }

    private async getLanguage(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        let language = null;

        if (organizationAndTeamData && organizationAndTeamData.teamId) {
            language = await this.parametersService.findByKey(
                ParametersKey.LANGUAGE_CONFIG,
                organizationAndTeamData,
            );
        }

        if (!language) {
            return 'en-US';
        }

        return language?.configValue || 'en-US';
    }
}
