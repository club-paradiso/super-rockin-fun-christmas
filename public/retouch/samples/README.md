# 피부 보정 시험용 사진

비교 페이지(`/retouch-lab`)와 `e2e/retouch.spec.ts` 가 쓰는 고정 샘플이다. 손님 사진은 한 장도 없다.

- 전부 **위키미디어 공용(Wikimedia Commons)** 에서 받았고, Commons API가 라이선스를 `Public domain` 으로 돌려준 파일만
  골랐다(확인 날짜 2026-11-24). 미국 연방 정부 기관(NASA, 에너지부, 육군, 해병대, 공군)과 의회도서관 FSA/OWI 사진이다.
  파일별 PD 틀(PD-USGov 등)까지는 따로 확인하지 않았다. Commons API의 `LicenseShortName` 과 저작자 표기만 확인했다.
- **저작권과 초상권은 다르다.** 저작권은 공개 영역이지만, 찍힌 사람의 초상권까지 풀린 것은 아니다. 그래서 공직자의
  공식 초상과 공무 중 사진만 썼고, 살아 있는 어린이의 사진은 쓰지 않았다(어린이 샘플은 1942~43년 사진이다).
  유명인과 고인의 초상(후보에 있던 두 장)은 뺐다. Commons가 personality rights 표기를 붙인 파일은 아래 표에 적었다.
  이 사진들은 보정 품질 시험에만 쓰고, 행사 홍보물이나 손님 화면에는 쓰지 않는다.
- 다른 사진으로 바꾸려면 파일을 넣고 `manifest.json` 의 줄을 바꾸면 된다(`faces` 는 960 × 720에서 보정될 것으로
  기대하는 얼굴 수의 최솟값).

| 파일                    | 무엇을 보는 샘플인가            | 원본 (Commons)                                                                                                                                                                                                               | 저작자 표기                                              | 촬영                     | 라이선스                                         |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| `dark-woman.jpg`        | 어두운 피부 · 여성              | [Jsc2023e047050 alt.jpg](https://commons.wikimedia.org/wiki/File:Jsc2023e047050_alt.jpg)                                                                                                                                     | NASA Johnson Space Center / Imagery Group                | Taken on 7 December 2023 | Public domain                                    |
| `older-woman.jpg`       | 주름 많은 얼굴 · 강한 조명      | [Sunita Williams in 2018.jpg](https://commons.wikimedia.org/wiki/File:Sunita_Williams_in_2018.jpg)                                                                                                                           | Robert Markowitz                                         | Taken on 31 July 2018    | Public domain                                    |
| `group-7.jpg`           | 단체 7명 · 작은 얼굴            | [STS-131 Official Crew Photo.jpg](https://commons.wikimedia.org/wiki/File:STS-131_Official_Crew_Photo.jpg)                                                                                                                   | NASA                                                     | 2009-10-21               | Public domain · Commons 표기: personality rights |
| `east-asian-fringe.jpg` | 동아시아 여성 · 앞머리          | [Naoko yamazaki.jpg](https://commons.wikimedia.org/wiki/File:Naoko_yamazaki.jpg)                                                                                                                                             | NASA                                                     | 2004-08-17               | Public domain                                    |
| `dark-man.jpg`          | 어두운 피부 · 남성 · 점         | [Victor J. Glover in 2018.jpg](https://commons.wikimedia.org/wiki/File:Victor_J._Glover_in_2018.jpg)                                                                                                                         | Robert Markowitz                                         | Taken on 31 July 2018    | Public domain                                    |
| `light-woman.jpg`       | 밝은 피부 · 여성                | [Shannon Walker official portrait 2020 (cropped).jpg](<https://commons.wikimedia.org/wiki/File:Shannon_Walker_official_portrait_2020_(cropped).jpg>)                                                                         | NASA/Norah Moran                                         | Taken on 15 June 2020    | Public domain                                    |
| `outdoor-man.jpg`       | 동아시아 남성 · 야외 자연광     | [Master Sgt Sean Im (9071970).jpg](<https://commons.wikimedia.org/wiki/File:Master_Sgt_Sean_Im_(9071970).jpg>)                                                                                                               | U.S. Army photo by Pfc. Seu Chan                         | Taken on 29 May 2025     | Public domain                                    |
| `glasses-man.jpg`       | 안경 · 점                       | [Steven Chu official portrait.jpg](https://commons.wikimedia.org/wiki/File:Steven_Chu_official_portrait.jpg)                                                                                                                 | United States Department of Energy                       | 2009-01-20               | Public domain                                    |
| `child-1942.jpg`        | 어린이 (1942년 컬러 필름)       | [Negro boy near Cincinnati, Ohio (LOC).jpg](<https://commons.wikimedia.org/wiki/File:Negro_boy_near_Cincinnati,_Ohio_(LOC).jpg>)                                                                                             | John Vachon                                              | [1942 or 1943]           | Public domain                                    |
| `elderly-glasses.jpg`   | 어르신 · 안경                   | [WWII visits former unit 121001-F-LX370-181.jpg](https://commons.wikimedia.org/wiki/File:WWII_visits_former_unit_121001-F-LX370-181.jpg)                                                                                     | Justin Connaher                                          | Taken on 1 October 2012  | Public domain                                    |
| `elderly-group.jpg`     | 어르신 · 흰 수염 · 3명 · 옆얼굴 | [Montford Point Marine Honored 130702-M-TF033-052.jpg](https://commons.wikimedia.org/wiki/File:Montford_Point_Marine_Honored_130702-M-TF033-052.jpg)                                                                         | Cpl. Erik Brooks                                         | Taken on 2 July 2013     | Public domain                                    |
| `indoor-glasses.jpg`    | 실내 혼합 조명 · 안경           | [ISS-69 Frank Rubio in Destiny.jpg](https://commons.wikimedia.org/wiki/File:ISS-69_Frank_Rubio_in_Destiny.jpg)                                                                                                               | NASA                                                     | Taken on 10 May 2023     | Public domain                                    |
| `east-asian-man.jpg`    | 동아시아 남성 · 스튜디오        | [Jsc2024e052605 alt (Aug. 6, 2024) --- Official portrait of NASA astronaut Jonny Kim.jpg](<https://commons.wikimedia.org/wiki/File:Jsc2024e052605_alt_(Aug._6,_2024)_---_Official_portrait_of_NASA_astronaut_Jonny_Kim.jpg>) | NASA Johnson Space Center / Josh Valcarcel – NASA – John | Taken on 6 August 2024   | Public domain                                    |
| `dim-indoor-sim.jpg`    | 어두운 실내 (모의)              | [Shannon Walker official portrait 2020 (cropped).jpg](<https://commons.wikimedia.org/wiki/File:Shannon_Walker_official_portrait_2020_(cropped).jpg>)                                                                         | NASA/Norah Moran                                         | Taken on 15 June 2020    | 모의(위 사진에서 만듦)                           |
| `backlit-sim.jpg`       | 역광 (모의)                     | [Jsc2024e052605 alt (Aug. 6, 2024) --- Official portrait of NASA astronaut Jonny Kim.jpg](<https://commons.wikimedia.org/wiki/File:Jsc2024e052605_alt_(Aug._6,_2024)_---_Official_portrait_of_NASA_astronaut_Jonny_Kim.jpg>) | NASA Johnson Space Center / Josh Valcarcel – NASA – John | Taken on 6 August 2024   | 모의(위 사진에서 만듦)                           |

가공: 1920 px 섬네일을 1600 px 폭으로 줄인 것을 받아, 부스 사진처럼 얼굴 둘레 4:3으로 잘랐다(자른 위치는
`manifest.json` 의 `processing`). `thumbs/` 는 240 × 180 축소본이다.

## 채우지 못한 조건

- **수염**: 얼굴이 큰 수염 사진을 찾지 못했다. `elderly-group.jpg` 의 흰 수염은 얼굴이 작다.
- **진한 화장**: 찾지 못했다.
- **어두운 실내, 역광**: 공개 영역의 실제 사진을 찾지 못해 위 사진에서 **모의로 만들었다**(`dim-indoor-sim.jpg`,
  `backlit-sim.jpg`. 만드는 식은 `manifest.json` 의 `processing`). 실제 행사장 조명을 대신하지 못한다.
- **젊은 동아시아인의 자연광 근접 사진**: 없다. 스튜디오 초상이 대부분이라 피부가 이미 고르다.

이 네 가지는 실기기와 실제 행사장 조명에서 사람이 봐야 한다.
