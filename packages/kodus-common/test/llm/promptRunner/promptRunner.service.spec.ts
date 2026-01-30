/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/unbound-method */
import {
    CustomStringOutputParser,
    LLMModelProvider,
    LLMProviderService,
    PromptRole,
    PromptRunnerParams,
    PromptRunnerService,
    PromptScope,
} from '@/llm';
import {
    BaseMessage,
    BaseMessageLike,
    HumanMessage,
} from '@langchain/core/messages';
import { Runnable, RunnableSequence } from '@langchain/core/runnables';
import { LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';

jest.mock('@langchain/core/runnables');

describe('PromptRunnerService', () => {
    let service: PromptRunnerService;
    let mockLLMProviderService: jest.Mocked<LLMProviderService>;
    let mockLogger: jest.Mocked<LoggerService>;

    const mockChain = {
        invoke: jest.fn(),
        withFallbacks: jest.fn().mockReturnThis(), // .mockReturnThis() allows chaining
        withConfig: jest.fn().mockReturnThis(),
    };
    const mockLlm: jest.Mocked<Runnable> = {
        invoke: jest.fn(),
    } as unknown as jest.Mocked<Runnable>;

    beforeEach(async () => {
        jest.clearAllMocks();

        (RunnableSequence.from as jest.Mock).mockReturnValue(mockChain);

        const module = await Test.createTestingModule({
            providers: [
                PromptRunnerService,
                {
                    provide: 'LLM_LOGGER',
                    useValue: {
                        error: jest.fn(),
                        log: jest.fn(),
                        warn: jest.fn(),
                    },
                },
                {
                    provide: LLMProviderService,
                    useValue: {
                        getLLMProvider: jest.fn(),
                    },
                },
            ],
        }).compile();

        service = module.get<PromptRunnerService>(PromptRunnerService);
        mockLLMProviderService = module.get(LLMProviderService);
        mockLogger = module.get('LLM_LOGGER');
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    describe('runPrompt', () => {
        it('should successfully run a simple prompt and return a string output', async () => {
            const expectedResponse = 'This is the AI response.';
            mockLLMProviderService.getLLMProvider.mockReturnValue(mockLlm);
            mockChain.invoke.mockResolvedValue(expectedResponse);

            const params: PromptRunnerParams<void, string> = {
                provider: LLMModelProvider.GEMINI_2_0_FLASH,
                parser: new CustomStringOutputParser(),
                prompts: [
                    {
                        role: PromptRole.USER,
                        prompt: 'Hello, world!',
                    },
                ],
                runName: 'test-run',
            };

            const result = await service.runPrompt(params);

            expect(result).toBe(expectedResponse);

            expect(mockLLMProviderService.getLLMProvider).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: LLMModelProvider.GEMINI_2_0_FLASH,
                }),
            );
            expect(RunnableSequence.from).toHaveBeenCalled();
            expect(mockChain.invoke).toHaveBeenCalledWith({});
            expect(mockLogger.error).not.toHaveBeenCalled();
        });

        it('should throw an error if the chain fails', async () => {
            const testError = new Error('LLM API failed');
            mockLLMProviderService.getLLMProvider.mockReturnValue(mockLlm);
            mockChain.invoke.mockRejectedValue(testError);

            const params: PromptRunnerParams<void, string> = {
                provider: LLMModelProvider.GEMINI_2_0_FLASH,
                parser: new CustomStringOutputParser(),
                prompts: [{ role: PromptRole.USER, prompt: 'This will fail.' }],
                runName: 'failing-run',
            };

            await expect(service.runPrompt(params)).rejects.toThrow(
                'LLM API failed',
            );
        });
    });

    describe('Parameter Validation', () => {
        it('should throw an error if provider is not defined', () => {
            const params = {
                parser: new CustomStringOutputParser(),
                prompts: [{ role: PromptRole.USER, prompt: 'test' }],
            } as unknown as PromptRunnerParams<void, string>;

            // Using a wrapper function to test for thrown errors
            expect(() => service.createChain(params)).toThrow(
                'Provider or BYOK config must be defined in the parameters.',
            );
        });

        it('should throw an error if parser is not defined', () => {
            const params = {
                provider: 'test-provider',
                prompts: [{ role: PromptRole.USER, prompt: 'test' }],
            } as unknown as PromptRunnerParams<void, string>;
            expect(() => service.createChain(params)).toThrow(
                'Parser must be defined',
            );
        });

        it('should throw an error if prompts array is empty', () => {
            const params = {
                provider: 'test-provider',
                parser: new CustomStringOutputParser(),
                prompts: [],
            } as unknown as PromptRunnerParams<void, string>;
            expect(() => service.createChain(params)).toThrow(
                'No prompts defined',
            );
        });
    });

    describe('Fallback Logic', () => {
        it('should create a chain with fallbacks when a fallbackProvider is provided', () => {
            const createProviderChainSpy = jest.spyOn(
                service,
                'createProviderChain',
            );
            const params: PromptRunnerParams<void> = {
                provider: LLMModelProvider.OPENAI_GPT_4O,
                fallbackProvider: LLMModelProvider.OPENAI_GPT_4O_MINI,
                parser: new CustomStringOutputParser(),
                prompts: [{ role: PromptRole.USER, prompt: 'test' }],
            };

            service.createChain(params);

            expect(createProviderChainSpy).toHaveBeenCalledTimes(2);
            expect(createProviderChainSpy).toHaveBeenNthCalledWith(1, params);
            expect(createProviderChainSpy).toHaveBeenNthCalledWith(
                2,
                params,
                true,
            );
            expect(mockChain.withFallbacks).toHaveBeenCalledWith({
                fallbacks: [mockChain],
            });
        });

        it('should use the correct provider for main and fallback chains', () => {
            const params: PromptRunnerParams<void> = {
                provider: LLMModelProvider.OPENAI_GPT_4O,
                fallbackProvider: LLMModelProvider.OPENAI_GPT_4O_MINI,
                parser: new CustomStringOutputParser(),
                prompts: [{ role: PromptRole.USER, prompt: 'test' }],
            };

            service.createChain(params);

            expect(mockLLMProviderService.getLLMProvider).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: LLMModelProvider.OPENAI_GPT_4O,
                }),
            );
            expect(mockLLMProviderService.getLLMProvider).toHaveBeenCalledWith(
                expect.objectContaining({
                    model: LLMModelProvider.OPENAI_GPT_4O_MINI,
                }),
            );
        });
    });

    describe('Prompt Scoping', () => {
        const getGeneratedPrompts = (payload = {}): BaseMessageLike[] => {
            const mockCalls = (RunnableSequence.from as jest.Mock).mock.calls;
            // Get the arguments from the most recent call to RunnableSequence.from
            const latestCallArgs = mockCalls[mockCalls.length - 1];
            // The first argument is the array of runnables: [promptFn, llm, parser]
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const runnableArray = latestCallArgs[0] as [
                CallableFunction,
                ...any[],
            ];
            // The prompt function is the first element in that array
            const promptFn = runnableArray[0];

            // eslint-disable-next-line @typescript-eslint/no-unsafe-call
            return promptFn(payload) as unknown as BaseMessageLike[];
        };

        const testPrompts = [
            {
                role: PromptRole.SYSTEM,
                prompt: 'Global prompt',
                scope: PromptScope.GLOBAL,
            },
            {
                role: PromptRole.USER,
                prompt: 'Main prompt',
                scope: PromptScope.MAIN,
            },
            {
                role: PromptRole.USER,
                prompt: 'Fallback prompt',
                scope: PromptScope.FALLBACK,
            },
            { role: PromptRole.SYSTEM, prompt: 'Scopeless prompt' },
            {
                prompt: new HumanMessage('Human message'),
                scope: PromptScope.GLOBAL,
            },
            {
                prompt: new HumanMessage('Human message 2'),
                scope: PromptScope.MAIN,
            },
            {
                prompt: new HumanMessage('Human message 3'),
                scope: PromptScope.FALLBACK,
            },
            { prompt: new HumanMessage('Human message 4') },
        ];

        const params: PromptRunnerParams<void> = {
            provider: LLMModelProvider.OPENAI_GPT_4O,
            parser: new CustomStringOutputParser(),
            prompts: testPrompts,
        };

        it('should only include GLOBAL and MAIN prompts when building the main chain', () => {
            service.createProviderChain(params); // fallback is false/undefined
            const result = getGeneratedPrompts();

            expect(result.length).toBe(6);
            const contents = result.map((p) => {
                if (p instanceof BaseMessage) {
                    return p.content;
                }
                if (typeof p === 'string') {
                    return p;
                }
                if (
                    'content' in p &&
                    Array.isArray(p.content) &&
                    p.content.length > 0 &&
                    typeof p.content[0] === 'object' &&
                    'text' in p.content[0] &&
                    typeof p.content[0].text === 'string'
                ) {
                    return p.content[0].text;
                }
            });
            expect(contents).toContain('Global prompt');
            expect(contents).toContain('Main prompt');
            expect(contents).not.toContain('Fallback prompt');
            expect(contents).toContain('Scopeless prompt');
            expect(contents).toContain('Human message');
            expect(contents).toContain('Human message 2');
            expect(contents).not.toContain('Human message 3');
            expect(contents).toContain('Human message 4');
        });

        it('should only include GLOBAL and FALLBACK prompts when building the fallback chain', () => {
            service.createProviderChain(params, true); // fallback is true
            const result = getGeneratedPrompts();

            expect(result.length).toBe(6);
            const contents = result.map((p) => {
                if (p instanceof BaseMessage) {
                    return p.content;
                }
                if (typeof p === 'string') {
                    return p;
                }
                if (
                    'content' in p &&
                    Array.isArray(p.content) &&
                    p.content.length > 0 &&
                    typeof p.content[0] === 'object' &&
                    'text' in p.content[0] &&
                    typeof p.content[0].text === 'string'
                ) {
                    return p.content[0].text;
                }
            });
            expect(contents).toContain('Global prompt');
            expect(contents).not.toContain('Main prompt');
            expect(contents).toContain('Fallback prompt');
            expect(contents).toContain('Scopeless prompt');
            expect(contents).toContain('Human message');
            expect(contents).not.toContain('Human message 2');
            expect(contents).toContain('Human message 3');
            expect(contents).toContain('Human message 4');
        });
    });
});
