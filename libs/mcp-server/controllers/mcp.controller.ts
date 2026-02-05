import {
    Controller,
    Post,
    Get,
    Delete,
    Body,
    Headers,
    Res,
    HttpStatus,
    UseGuards,
    Inject,
} from '@nestjs/common';
import { Response, Request } from 'express';
import {
    ApiBody,
    ApiHeader,
    ApiOperation,
    ApiProduces,
    ApiTags,
} from '@nestjs/swagger';
import { McpServerService } from '../services/mcp-server.service';
import { McpEnabledGuard } from '../guards/mcp-enabled.guard';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { MCPManagerService } from '../services/mcp-manager.service';
import { REQUEST } from '@nestjs/core';
import { toJsonRpcError } from '../utils/serialize';
import { JsonRpcCode } from '../utils/errors';
import { createLogger } from '@kodus/flow';

function getJsonRpcId(body: any): string | number | null {
    return body && (typeof body.id === 'string' || typeof body.id === 'number')
        ? body.id
        : null;
}

function accepts(req: Request, mime: string) {
    const h = (req.headers['accept'] || '').toString().toLowerCase();
    return h.includes(mime.toLowerCase());
}

@ApiTags('MCP')
@Controller('mcp')
@UseGuards(McpEnabledGuard)
export class McpController {
    private readonly logger = createLogger(McpController.name);

    constructor(
        private readonly mcpServerService: McpServerService,
        private readonly mcpManagerService: MCPManagerService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    @Post()
    @ApiOperation({
        summary: 'Handle MCP client request',
        description:
            'Handles JSON-RPC MCP client requests. For initialization, send `Accept: application/json, text/event-stream` and the server responds over SSE with `mcp-session-id` header. Use `mcp-session-id` to continue an existing session.',
    })
    @ApiHeader({
        name: 'accept',
        required: true,
        description:
            'For initialization use `application/json, text/event-stream` to allow SSE responses.',
    })
    @ApiHeader({
        name: 'mcp-session-id',
        required: false,
        description:
            'Session identifier returned after MCP initialization. Required for subsequent requests.',
    })
    @ApiProduces('application/json', 'text/event-stream')
    @ApiBody({
        schema: {
            type: 'object',
            description: 'JSON-RPC request payload (MCP protocol).',
            additionalProperties: true,
            example: {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'local', version: '1.0.0' },
                },
            },
        },
    })
    async handleClientRequest(
        @Body() body: any,
        @Headers('mcp-session-id') sessionId: string | undefined,
        @Res() res: Response,
    ) {
        const id = getJsonRpcId(body);
        try {
            if (!accepts(res.req, 'application/json')) {
                return res.status(HttpStatus.NOT_ACCEPTABLE).json(
                    toJsonRpcError(
                        {
                            code: JsonRpcCode.INVALID_REQUEST,
                            message: 'Client must accept application/json',
                        },
                        id,
                    ),
                );
            }

            if (sessionId && this.mcpServerService.hasSession(sessionId)) {
                await this.mcpServerService.handleRequest(sessionId, body, res);
                return;
            }

            if (!sessionId && isInitializeRequest(body)) {
                const newSessionId =
                    await this.mcpServerService.createSession();
                await this.mcpServerService.handleRequest(
                    newSessionId,
                    body,
                    res,
                );
                return;
            }

            return res.status(HttpStatus.BAD_REQUEST).json(
                toJsonRpcError(
                    {
                        code: JsonRpcCode.INVALID_REQUEST,
                        message:
                            'Bad Request: missing or invalid Mcp-Session-Id',
                    },
                    id,
                ),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error handling MCP request',
                context: McpController.name,
                error,
                metadata: { sessionId, body },
            });
            return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(
                toJsonRpcError(
                    {
                        code: JsonRpcCode.INTERNAL_ERROR,
                        message: 'Internal error',
                        data: { reason: 'controller-failure' },
                    },
                    id,
                ),
            );
        }
    }

    @Get()
    @ApiOperation({
        summary: 'Handle MCP server notifications',
        description:
            'Streams MCP server notifications over SSE. Requires `Accept: text/event-stream` and a valid `mcp-session-id`.',
    })
    @ApiHeader({
        name: 'mcp-session-id',
        required: true,
        description: 'Active MCP session identifier.',
    })
    @ApiProduces('text/event-stream')
    async handleServerNotifications(
        @Headers('mcp-session-id') sessionId: string | undefined,
        @Res() res: Response,
    ) {
        if (!accepts(res.req, 'text/event-stream')) {
            return res
                .status(HttpStatus.NOT_ACCEPTABLE)
                .send('Client must accept text/event-stream');
        }

        if (!sessionId || !this.mcpServerService.hasSession(sessionId)) {
            return res
                .status(HttpStatus.BAD_REQUEST)
                .send('Invalid or missing session ID');
        }
        await this.mcpServerService.handleServerNotifications(sessionId, res);
    }

    @Delete()
    @ApiOperation({
        summary: 'Terminate MCP session',
        description:
            'Terminates an MCP session by session id provided in `mcp-session-id` header.',
    })
    @ApiHeader({
        name: 'mcp-session-id',
        required: true,
        description: 'Active MCP session identifier.',
    })
    async handleSessionTermination(
        @Headers('mcp-session-id') sessionId: string | undefined,
        @Res() res: Response,
    ) {
        if (!sessionId || !this.mcpServerService.hasSession(sessionId)) {
            return res
                .status(HttpStatus.BAD_REQUEST)
                .send('Invalid or missing session ID');
        }
        await this.mcpServerService.terminateSession(sessionId, res);
    }
}
