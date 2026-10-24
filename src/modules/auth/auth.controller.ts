import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';

class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  account!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}

class RegisterDto {
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{3,64}$/, { message: '账号需为 3-64 位字母、数字、下划线或连字符' })
  account!: string;

  @IsString()
  @MinLength(8, { message: '密码至少需要 8 位' })
  @MaxLength(128)
  password!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  nickname!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.account, dto.password);
  }

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto.account, dto.password, dto.nickname);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(): Promise<void> {
    await this.auth.logout();
  }
}

@Controller('users')
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get('me')
  me() {
    return this.auth.me();
  }
}
