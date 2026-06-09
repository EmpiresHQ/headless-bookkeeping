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
import { ApiTags } from '@nestjs/swagger';
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
  async resolve(@Body() input: ResolveInput): Promise<Conversation> {
    return this.conversationsService.resolve(input);
  }

  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  async appendMessage(@Body() input: AppendMessageInput): Promise<Message> {
    return this.conversationsService.appendMessage(input);
  }

  @Post('artifacts')
  @HttpCode(HttpStatus.CREATED)
  async attachArtifact(@Body() input: AttachArtifactInput): Promise<Artifact> {
    return this.conversationsService.attachArtifact(input);
  }

  @Post('associate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async associate(@Body() input: AssociateInput): Promise<void> {
    return this.conversationsService.associate(input);
  }

  @Post('associate-document')
  @HttpCode(HttpStatus.NO_CONTENT)
  async associateDocument(
    @Body() input: AssociateDocumentInput,
  ): Promise<void> {
    return this.conversationsService.associateDocument(input);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  async close(@Param('id', ParseIntPipe) id: number): Promise<Conversation> {
    return this.conversationsService.close(id);
  }

  @Get()
  async list(): Promise<{ conversations: Conversation[] }> {
    return { conversations: await this.conversationsService.list() };
  }

  @Get(':id')
  async getById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ConversationWithDetails> {
    return this.conversationsService.getById(id);
  }

  @Get('for-object')
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
