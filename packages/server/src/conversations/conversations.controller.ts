import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ConversationsService } from './conversations.service';
import {
  ResolveInput,
  AppendMessageInput,
  AttachArtifactInput,
  AssociateInput,
  AssociateDocumentInput,
} from './types';
import type {
  Conversation,
  ConversationWithDetails,
  Message,
  Artifact,
  BusinessObjectType,
} from './types';

@ApiTags('conversations')
@Controller('api/conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve a conversation',
    description: 'Resolve (find-or-create) a conversation for a context.',
  })
  async resolve(@Body() input: ResolveInput): Promise<Conversation> {
    return this.conversationsService.resolve(input);
  }

  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Append a message',
    description: 'Append a message to a conversation.',
  })
  async appendMessage(@Body() input: AppendMessageInput): Promise<Message> {
    return this.conversationsService.appendMessage(input);
  }

  @Post('artifacts')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Attach an artifact',
    description: 'Attach an artifact to a conversation.',
  })
  async attachArtifact(@Body() input: AttachArtifactInput): Promise<Artifact> {
    return this.conversationsService.attachArtifact(input);
  }

  @Post('associate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Associate an object',
    description: 'Associate a domain object with a conversation.',
  })
  async associate(@Body() input: AssociateInput): Promise<void> {
    return this.conversationsService.associate(input);
  }

  @Post('associate-document')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Associate a document',
    description: 'Associate a source document with a conversation.',
  })
  async associateDocument(
    @Body() input: AssociateDocumentInput,
  ): Promise<void> {
    return this.conversationsService.associateDocument(input);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close a conversation',
    description: 'Close a conversation thread.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  async close(@Param('id', ParseIntPipe) id: number): Promise<Conversation> {
    return this.conversationsService.close(id);
  }

  @Get()
  @ApiOperation({
    summary: 'List conversations',
    description: 'Return all conversations.',
  })
  async list(): Promise<{ conversations: Conversation[] }> {
    return { conversations: await this.conversationsService.list() };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a conversation by id',
    description: 'Fetch a single conversation.',
  })
  @ApiParam({ name: 'id', description: 'Conversation id' })
  async getById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ConversationWithDetails> {
    return this.conversationsService.getById(id);
  }

  @Get('for-object')
  @ApiOperation({
    summary: 'Find a conversation for an object',
    description: 'Look up the conversation linked to a domain object.',
  })
  @ApiQuery({
    name: 'object_type',
    description: 'Business object type (e.g. invoice, supplier)',
    required: true,
  })
  @ApiQuery({
    name: 'object_id',
    description: 'Numeric id of the domain object',
    required: true,
  })
  async getForObject(
    @Query('object_type') object_type: BusinessObjectType,
    @Query('object_id', ParseIntPipe) object_id: number,
  ): Promise<{ conversations: ConversationWithDetails[] }> {
    return {
      conversations: await this.conversationsService.getForObject(
        object_type,
        object_id,
      ),
    };
  }
}
