import { Body, Controller, Get, Patch } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { AuthService } from './auth.service.js';

class UpdateProfileDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @IsNotEmpty({ message: '请填写昵称' })
  @MaxLength(50)
  nickname!: string;
}
@Controller('users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}
  @Get('me')
  me() { return this.auth.me(); }
  @Patch('me')
  update(@Body() dto: UpdateProfileDto) { return this.auth.updateNickname(dto.nickname); }
}
