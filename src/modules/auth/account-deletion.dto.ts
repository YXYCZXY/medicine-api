import { Equals, IsString, IsUUID, Matches } from 'class-validator';

export class DeleteAccountDto {
  @IsUUID('4') operationId!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) receiptSecret!: string;
  @IsString()
  @Matches(/^\d{6}$/, { message: '请输入 6 位短信验证码' })
  code!: string;
  @Equals('DELETE_ALL_DATA', { message: '请确认永久删除账号及全部数据' })
  confirmation!: string;
}
